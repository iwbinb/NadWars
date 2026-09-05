import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { encodeFunctionData } from "viem";
import artifact from "../src/chain/contract.json" with { type: "json" };
import { artifacts, detectMode, matchesCreation } from "../src/chain/verify.js";

const READ_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getCode",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getTransactionCount",
  "eth_getBalance",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getLogs",
]);
const ALLOWED = new Set([...READ_METHODS, "eth_sendRawTransaction"]);

export function localApi() {
  let rpcUrl,
    generation,
    storePath,
    rooms = [],
    funded = new Set();
  const id = randomUUID();
  const relayQueues = Array.from({ length: 4 }, () => Promise.resolve());
  async function rpc(method, params = [], retry = true) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json();
    if (body.error) {
      // Monad's local pending state can be temporarily unavailable. Retry reads only.
      if (
        retry &&
        READ_METHODS.has(method) &&
        /Required data unavailable/i.test(body.error.message)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return rpc(method, params, false);
      }
      throw new Error(body.error.message);
    }
    return body.result;
  }
  async function node() {
    const info = await rpc("anvil_nodeInfo");
    if (
      info.network !== "monad" ||
      info.hardFork !== "MonadTen" ||
      Number(info.environment.chainId) !== 31337 ||
      info.forkConfig?.forkUrl
    )
      throw new Error("需要独立的本地 MonadTen 测试链（31337）");
    return info;
  }
  async function save() {
    await mkdir(resolve(storePath, ".."), { recursive: true });
    await writeFile(storePath, JSON.stringify({ generation, rooms }), {
      mode: 0o600,
    });
  }
  async function body(req) {
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 160000) throw new Error("请求过大");
    }
    return JSON.parse(text || "{}");
  }
  return {
    name: "nadwars-local-chain-api",
    apply: "serve",
    async configureServer(server) {
      rpcUrl = process.env.NADWARS_DEV_RPC || "http://127.0.0.1:18547";
      const parsed = new URL(rpcUrl);
      if (
        parsed.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
      )
        throw new Error("Local development API only accepts loopback RPC");
      storePath = resolve(
        process.env.NADWARS_DATA_DIR || resolve(tmpdir(), "nadwars-local"),
        "rooms.json",
      );
      try {
        const info = await node();
        const block = await rpc("eth_getBlockByNumber", ["0x0", false]);
        generation = block.hash;
        try {
          const data = JSON.parse(await readFile(storePath, "utf8"));
          if (data.generation === generation) rooms = data.rooms || [];
        } catch {}
        server.config.logger.info(`NadWars local chain: ${info.hardFork}`);
      } catch {
        generation = id;
      }

      server.middlewares.use(async (req, res, next) => {
        const path = (req.url || "").split("?")[0];
        if (!path.startsWith("/api/")) return next();
        const send = (status, data) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(data));
        };
        // The privileged faucet exists only in Vite development, with host/origin checks.
        const host = (req.headers.host || "").split(":")[0];
        if (!["127.0.0.1", "localhost", "["].includes(host))
          return send(403, { error: "仅限本机开发" });
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`)
          return send(403, { error: "来源不匹配" });
        try {
          if (path === "/api/config" && req.method === "GET") {
            await node();
            return send(200, {
              network: {
                id: 31337,
                name: "本地 MonadTen",
                rpc: "/api/rpc",
                nativeCurrency: {
                  name: "Test MON",
                  symbol: "MON",
                  decimals: 18,
                },
                explorer: null,
              },
              localTestWallet: true,
              practice: true,
              roomApi: true,
              generation,
            });
          }
          if (path === "/api/rpc" && req.method === "POST") {
            const payload = await body(req);
            const calls = Array.isArray(payload) ? payload : [payload];
            if (calls.length > 24 || calls.some((x) => !ALLOWED.has(x.method)))
              return send(403, { error: "RPC 方法不允许" });
            for (const call of calls)
              if (
                call.method === "eth_estimateGas" &&
                (!call.params[1] || call.params[1] === "pending")
              )
                call.params[1] = "latest";
            const response = await fetch(rpcUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(20000),
            });
            let data = await response.json();
            // Anvil Monad may briefly lack pending execution data while another wallet's tx is mining.
            // Only retry read/simulation calls, preserving request IDs. Never resend a signed write here.
            const replies = Array.isArray(data) ? data : [data];
            for (const reply of replies)
              if (reply.error)
                server.config.logger.warn(
                  `local-rpc ${calls.find((c) => c.id === reply.id)?.method || "batch"}: ${String(reply.error.message).slice(0, 100)}`,
                );
            data = await Promise.all(
              replies.map(async (reply) => {
                const call = calls.find((c) => c.id === reply.id);
                if (!call || !READ_METHODS.has(call.method)) return reply;
                for (
                  let attempt = 0;
                  attempt < 5 &&
                  /Required data unavailable/i.test(reply.error?.message || "");
                  attempt++
                ) {
                  await new Promise((resolve) => setTimeout(resolve, 250));
                  try {
                    return {
                      jsonrpc: "2.0",
                      id: call.id,
                      result: await rpc(call.method, call.params, false),
                    };
                  } catch (error) {
                    reply = {
                      jsonrpc: "2.0",
                      id: call.id,
                      error: { code: -32000, message: String(error.message) },
                    };
                  }
                }
                return reply;
              }),
            );
            if (!Array.isArray(payload)) data = data[0];
            return send(response.status, data);
          }
          if (path === "/api/dev/fund" && req.method === "POST") {
            await node();
            const { address } = await body(req);
            if (!/^0x[0-9a-fA-F]{40}$/.test(address || ""))
              return send(400, { error: "地址无效" });
            const key = address.toLowerCase();
            if (!funded.has(key)) {
              if (funded.size >= 64)
                return send(429, { error: "本地测试钱包数量已达上限" });
              const balance = BigInt(
                await rpc("eth_getBalance", [address, "latest"]),
              );
              if (balance < 10n ** 19n)
                await rpc("anvil_setBalance", [address, "0x8ac7230489e80000"]);
              funded.add(key);
            }
            return send(200, { ok: true });
          }
          if (path === "/api/relay" && req.method === "POST") {
            const { address, action, signature } = await body(req);
            if (
              !/^0x[0-9a-fA-F]{40}$/.test(address || "") ||
              !/^0x[0-9a-fA-F]{130}$/.test(signature || "")
            )
              return send(400, { error: "操作签名格式无效" });
            await node();
            const mode = detectMode(
              await rpc("eth_getCode", [address, "latest"]),
            );
            if (!mode) return send(400, { error: "合约版本未通过验证" });
            const a = {
              player: action.player,
              nonce: BigInt(action.nonce),
              deadline: BigInt(action.deadline),
              sessionVersion: Number(action.sessionVersion),
              action: Number(action.action),
              ...(mode === "standard" ? { zone: Number(action.zone) } : {}),
              tile: Number(action.tile),
              kind: Number(action.kind),
            };
            const data = encodeFunctionData({
              abi: artifacts[mode].abi,
              functionName: "actSigned",
              args: [a, signature],
            });
            const lane = mode === "standard" ? a.zone : 0;
            if (!Number.isInteger(lane) || lane < 0 || lane > 3)
              return send(400, { error: "战区无效" });
            const pending = relayQueues[lane].then(async () => {
              const accounts = await rpc("eth_accounts"),
                from = accounts[lane];
              const tx = { from, to: address, data };
              const estimate = BigInt(
                await rpc("eth_estimateGas", [tx, "latest"]),
              );
              if (estimate > 1000000n) throw new Error("操作超过本局转发额度");
              tx.gas = `0x${((estimate * 11n + 9n) / 10n).toString(16)}`;
              return rpc("eth_sendTransaction", [tx]);
            });
            relayQueues[lane] = pending
              .then(async (hash) => {
                for (let i = 0; i < 40; i++) {
                  if (await rpc("eth_getTransactionReceipt", [hash])) return;
                  await new Promise((resolve) => setTimeout(resolve, 250));
                }
                throw new Error("上一笔操作尚未确认");
              })
              .catch(() => {});
            return send(200, { hash: await pending });
          }
          if (path === "/api/rooms" && req.method === "GET")
            return send(200, { rooms: [...rooms].reverse().slice(0, 30) });
          const roomLookup = path.match(/^\/api\/rooms\/(0x[0-9a-fA-F]{40})$/);
          if (roomLookup && req.method === "GET") {
            const room = rooms.find(
              (r) => r.address.toLowerCase() === roomLookup[1].toLowerCase(),
            );
            return room ? send(200, room) : send(404, { error: "对局未登记" });
          }
          if (path === "/api/rooms" && req.method === "POST") {
            const data = await body(req);
            if (
              !/^0x[0-9a-fA-F]{40}$/.test(data.address || "") ||
              !/^0x[0-9a-fA-F]{64}$/.test(data.transaction || "")
            )
              return send(400, { error: "对局信息无效" });
            const receipt = await rpc("eth_getTransactionReceipt", [
              data.transaction,
            ]);
            if (
              !receipt ||
              receipt.status !== "0x1" ||
              receipt.contractAddress?.toLowerCase() !==
                data.address.toLowerCase()
            )
              return send(400, { error: "尚未确认合约部署" });
            const room = {
              address: data.address,
              mode: detectMode(
                await rpc("eth_getCode", [data.address, "latest"]),
              ),
              deploymentBlock: receipt.blockNumber,
              transaction: data.transaction,
              name: String(data.name || "双人能源战")
                .trim()
                .slice(0, 30),
              createdAt: Date.now(),
            };
            if (!room.mode) return send(400, { error: "合约版本未通过验证" });
            if (
              !matchesCreation(
                await rpc("eth_getTransactionByHash", [data.transaction]),
                room.mode,
              )
            )
              return send(400, { error: "对局创建代码未通过验证" });
            if (
              !rooms.some(
                (x) => x.address.toLowerCase() === room.address.toLowerCase(),
              )
            ) {
              rooms.push(room);
              rooms = rooms.slice(-100);
              await save();
            }
            return send(200, room);
          }
          send(404, { error: "接口不存在" });
        } catch (err) {
          send(503, {
            error:
              path === "/api/config"
                ? "本地链尚未就绪，请保持开发服务运行。"
                : String(err.message).slice(0, 220),
          });
        }
      });
    },
  };
}
