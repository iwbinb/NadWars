import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  encodeFunctionData,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifacts, detectMode, matchesCreation } from "../src/chain/verify.js";

export type Bindings = Env & { RPC_URL?: string; RELAY_KEYS?: string };
export type Mode = "practice" | "standard";
export type Room = {
  address: Address;
  mode: Mode;
  name: string;
  deploymentBlock: string;
  transaction: Hex;
  createdAt: number;
};
export type RelayRequest = {
  address: Address;
  signature: Hex;
  action: {
    player: Address;
    nonce: string;
    deadline: string;
    sessionVersion: number;
    action: number;
    zone?: number;
    tile: number;
    kind: number;
  };
};
export class PublicError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export const addressPattern = /^0x[0-9a-fA-F]{40}$/;
export const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const methods = new Set([
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
  "eth_sendRawTransaction",
]);
export const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
export async function boundedJSON(
  input: Request | Response,
  max = 100_000,
): Promise<unknown> {
  if (Number(input.headers.get("content-length") || 0) > max)
    throw new PublicError("请求过大", 413);
  if (!input.body) throw new PublicError("缺少请求内容");
  const reader = input.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new PublicError("请求过大", 413);
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PublicError("JSON 格式无效");
  }
}
export function rpcURL(env: Bindings) {
  const value = env.RPC_URL || env.PUBLIC_RPC_URL,
    url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(
      env.NETWORK === "local" &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    )
  )
    throw new PublicError("链上网络配置无效", 503);
  return value;
}
export function chainFor(env: Bindings) {
  return defineChain({
    id: env.NETWORK === "local" ? 31337 : 10143,
    name: env.NETWORK === "local" ? "本地 MonadTen" : "Monad Testnet",
    nativeCurrency: { name: "Test MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpcURL(env)] } },
    testnet: true,
  });
}
export function publicClient(env: Bindings) {
  return createPublicClient({
    chain: chainFor(env),
    transport: http(rpcURL(env), { timeout: 12000, retryCount: 1 }),
  });
}
export async function checkNetwork(env: Bindings) {
  const client = publicClient(env);
  if ((await client.getChainId()) !== chainFor(env).id)
    throw new PublicError("RPC 网络与对局不一致", 503);
  return client;
}
export function validatedRPC(payload: unknown) {
  const calls = Array.isArray(payload) ? payload : [payload];
  if (!calls.length || calls.length > 20)
    throw new PublicError("RPC 批次超出范围");
  for (const raw of calls) {
    const c = raw as { method?: string; params?: unknown[] };
    if (!c || !methods.has(c.method || ""))
      throw new PublicError("RPC 方法不允许", 403);
    if (c.params == null) c.params = [];
    if (!Array.isArray(c.params)) throw new PublicError("RPC 参数无效");
    if (c.method === "eth_getLogs") {
      const q = c.params[0] as {
        address?: string;
        fromBlock?: string;
        toBlock?: string;
      };
      if (
        !q ||
        !addressPattern.test(q.address || "") ||
        !/^0x[0-9a-f]+$/i.test(q.fromBlock || "") ||
        !/^0x[0-9a-f]+$/i.test(q.toBlock || "")
      )
        throw new PublicError("日志查询需指定合约与区块范围");
      if (
        BigInt(q.toBlock!) - BigInt(q.fromBlock!) < 0n ||
        BigInt(q.toBlock!) - BigInt(q.fromBlock!) > 500n
      )
        throw new PublicError("日志查询范围过大");
    }
    if (
      (c.method === "eth_getBlockByNumber" ||
        c.method === "eth_getBlockByHash") &&
      c.params[1] !== false
    )
      throw new PublicError("不支持完整区块交易查询");
  }
  return calls;
}
export async function proxyRPC(env: Bindings, payload: unknown) {
  const calls = validatedRPC(payload);
  // Some public Monad endpoints reject JSON-RPC batches. Forward individually with a bounded fan-out.
  const results = [];
  for (let i = 0; i < calls.length; i += 4)
    results.push(
      ...(await Promise.all(
        calls.slice(i, i + 4).map(async (c) => {
          const response = await fetch(rpcURL(env), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(c),
            signal: AbortSignal.timeout(15000),
          });
          return boundedJSON(response, 1_000_000);
        }),
      )),
    );
  return Array.isArray(payload) ? results : results[0];
}
export async function verifyRoom(env: Bindings, input: unknown): Promise<Room> {
  const data = input as Partial<Room>;
  if (
    !addressPattern.test(data?.address || "") ||
    !hashPattern.test(data?.transaction || "")
  )
    throw new PublicError("对局信息无效");
  const client = await checkNetwork(env),
    receipt = await client.getTransactionReceipt({ hash: data.transaction! });
  if (
    receipt.status !== "success" ||
    receipt.contractAddress?.toLowerCase() !== data.address!.toLowerCase()
  )
    throw new PublicError("合约部署尚未确认");
  const mode = detectMode(await client.getCode({ address: data.address! }));
  if (!mode) throw new PublicError("合约版本未通过验证");
  if (
    !matchesCreation(
      await client.getTransaction({ hash: data.transaction! }),
      mode,
    )
  )
    throw new PublicError("对局创建代码未通过验证");
  return {
    address: data.address!.toLowerCase() as Address,
    mode: mode as Mode,
    name: String(data.name || "四区能源战")
      .trim()
      .slice(0, 30),
    deploymentBlock: receipt.blockNumber.toString(),
    transaction: data.transaction!,
    createdAt: Date.now(),
  };
}
export function relayInput(input: unknown): RelayRequest {
  const d = input as RelayRequest,
    a = d?.action;
  if (
    !addressPattern.test(d?.address || "") ||
    !/^0x[0-9a-f]{130}$/i.test(d?.signature || "") ||
    !addressPattern.test(a?.player || "") ||
    !/^\d{1,20}$/.test(a?.nonce || "") ||
    !/^\d{1,20}$/.test(a?.deadline || "")
  )
    throw new PublicError("操作签名格式无效");
  for (const [n, max] of [
    [a.action, 3],
    [a.zone ?? 0, 3],
    [a.tile, 48],
    [a.kind, 5],
    [a.sessionVersion, 4294967295],
  ])
    if (!Number.isInteger(n) || n < 0 || n > max)
      throw new PublicError("操作参数超出范围");
  return d;
}
export function relayFingerprint(input: RelayRequest) {
  const a = input.action;
  return keccak256(
    toHex(
      JSON.stringify([
        input.address.toLowerCase(),
        a.player.toLowerCase(),
        a.nonce,
        a.deadline,
        a.sessionVersion,
        a.action,
        a.zone ?? 0,
        a.tile,
        a.kind,
        input.signature.toLowerCase(),
      ]),
    ),
  );
}
export function signer(env: Bindings, lane: number) {
  let keys: unknown;
  try {
    keys = JSON.parse(env.RELAY_KEYS || "[]");
  } catch {
    throw new PublicError("赞助未配置", 503);
  }
  if (
    !Array.isArray(keys) ||
    keys.length !== 4 ||
    new Set(keys).size !== 4 ||
    !keys.every((k) => typeof k === "string" && /^0x[0-9a-f]{64}$/i.test(k))
  )
    throw new PublicError("需要四个独立的测试网赞助账户", 503);
  const account = privateKeyToAccount(keys[lane] as Hex);
  return createWalletClient({
    account,
    chain: chainFor(env),
    transport: http(rpcURL(env), { retryCount: 0, timeout: 12000 }),
  });
}
export async function prepareRelay(
  env: Bindings,
  lane: number,
  input: RelayRequest,
) {
  const client = await checkNetwork(env),
    wallet = signer(env, lane);
  const mode = detectMode(await client.getCode({ address: input.address }));
  if (!mode) throw new PublicError("合约版本未通过验证");
  const action = {
    ...input.action,
    nonce: BigInt(input.action.nonce),
    deadline: BigInt(input.action.deadline),
  };
  if ((mode === "standard" ? action.zone : 0) !== lane)
    throw new PublicError("转发通道不匹配");
  const data = encodeFunctionData({
    abi: artifacts[mode as Mode].abi as Abi,
    functionName: "actSigned",
    args: [action, input.signature],
  });
  const gas = await client.estimateGas({
    account: wallet.account.address,
    to: input.address,
    data,
    blockTag: "latest",
  });
  if (gas > 750000n) throw new PublicError("操作超过赞助 Gas 上限");
  const gasPrice = await client.getGasPrice();
  if (gasPrice > 200_000_000_000n)
    throw new PublicError("网络费用超过赞助上限，请稍后重试");
  const request = await wallet.prepareTransactionRequest({
    account: wallet.account,
    to: input.address,
    data,
    gas: (gas * 11n) / 10n,
    gasPrice,
    type: "legacy",
  });
  const raw = await wallet.signTransaction(request),
    hash = keccak256(raw);
  return {
    raw,
    hash,
    nonce: request.nonce,
    address: input.address,
    player: input.action.player,
    actionNonce: input.action.nonce,
    fingerprint: relayFingerprint(input),
    created: Date.now(),
    attempts: 0,
  };
}
