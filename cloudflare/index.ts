import { DurableObject } from "cloudflare:workers";
import { type Hex } from "viem";
import {
  type Bindings,
  type Room,
  type RelayRequest,
  PublicError,
  json,
  boundedJSON,
  publicClient,
  checkNetwork,
  verifyRoom,
  proxyRPC,
  relayInput,
  relayFingerprint,
  prepareRelay,
  addressPattern,
  hashPattern,
} from "./protocol";

export class RoomDirectory extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS rooms(address TEXT PRIMARY KEY, payload TEXT NOT NULL, created INTEGER NOT NULL)",
    );
  }
  register(room: Room) {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO rooms(address,payload,created) VALUES(?,?,?)",
      room.address,
      JSON.stringify(room),
      room.createdAt,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM rooms WHERE address NOT IN (SELECT address FROM rooms ORDER BY created DESC LIMIT 500)",
    );
    return room;
  }
  list() {
    return this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM rooms ORDER BY created DESC LIMIT 30",
      )
      .toArray()
      .map((r) => JSON.parse(r.payload) as Room);
  }
  get(address: string) {
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM rooms WHERE address=?",
        address.toLowerCase(),
      )
      .toArray()[0];
    return row ? (JSON.parse(row.payload) as Room) : null;
  }
}

export class RoomHub extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }
  async fetch(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return json({ error: "需要 WebSocket" }, 426);
    if (this.ctx.getWebSockets().length >= 24)
      return json({ error: "房间连接已满" }, 429);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      id: crypto.randomUUID(),
      messages: 0,
      window: Date.now(),
    });
    server.send(
      JSON.stringify({
        type: "hello",
        connections: this.ctx.getWebSockets().length,
      }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }
  changed(block: string) {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(JSON.stringify({ type: "changed", block }));
      } catch {
        socket.close(1011, "reconnect");
      }
    }
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" || message.length > 128) {
      ws.close(1008, "invalid message");
      return;
    }
    // Client messages never declare results, seats, player identities or chain state.
    if (message !== "ping") ws.close(1008, "unsupported message");
  }
  webSocketClose(ws: WebSocket, code: number) {
    ws.close(code, "closed");
  }
  webSocketError(ws: WebSocket) {
    ws.close(1011, "reconnect");
  }
}

type Pending = Awaited<ReturnType<typeof prepareRelay>>;
export class SponsorLane extends DurableObject<Bindings> {
  private queue: Promise<unknown> = Promise.resolve();
  async submit(lane: number, input: RelayRequest) {
    const next = this.queue.then(() => this.execute(lane, input));
    this.queue = next.catch(() => {});
    try {
      return { ok: true as const, ...(await next) };
    } catch (error) {
      return {
        ok: false as const,
        error:
          error instanceof PublicError
            ? error.message
            : "操作预演未通过，请同步战场后重试",
        status: error instanceof PublicError ? error.status : 400,
      };
    }
  }
  private async execute(lane: number, input: RelayRequest) {
    if (this.env.SPONSOR_ENABLED !== "true")
      throw new PublicError("赞助未启用", 503);
    if (!Number.isInteger(lane) || lane < 0 || lane > 3)
      throw new PublicError("通道无效");
    const pending = await this.ctx.storage.get<Pending>("pending");
    if (pending) {
      if (
        pending.address.toLowerCase() === input.address.toLowerCase() &&
        pending.player.toLowerCase() === input.action.player.toLowerCase() &&
        pending.actionNonce === input.action.nonce
      ) {
        if (pending.fingerprint !== relayFingerprint(input))
          throw new PublicError("该动作序号已提交另一项操作，请先核实", 409);
        return { hash: pending.hash };
      }
      await this.reconcile();
      if (await this.ctx.storage.get("pending"))
        throw new PublicError("转发通道正在核实上一笔交易，请稍后重试", 409);
    }
    const gameKey = `game:${input.address.toLowerCase()}`,
      dayKey = `day:${Math.floor(Date.now() / 86400000)}`;
    const used = (await this.ctx.storage.get<number>(gameKey)) || 0,
      day = (await this.ctx.storage.get<number>(dayKey)) || 0;
    if (used >= 260 || day >= 1500)
      throw new PublicError("本局或当日赞助额度已用完", 429);
    const prepared = await prepareRelay(this.env, lane, input);
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put({
        pending: prepared,
        [gameKey]: used + 1,
        [dayKey]: day + 1,
      });
    });
    // Persist the signed transaction before broadcast. Retries always use the identical hash/nonce.
    await this.ctx.storage.setAlarm(Date.now() + 1500);
    try {
      await publicClient(this.env).sendRawTransaction({
        serializedTransaction: prepared.raw,
      });
    } catch {
      /* The response may be lost after acceptance. Reconcile the same hash. */
    }
    return { hash: prepared.hash };
  }
  private async reconcile() {
    const pending = await this.ctx.storage.get<Pending>("pending");
    if (!pending) return;
    const client = publicClient(this.env);
    const receipt = await client
      .getTransactionReceipt({ hash: pending.hash })
      .catch(() => null);
    if (receipt) {
      await this.ctx.storage.delete("pending");
      await this.env.ROOMS.getByName(pending.address.toLowerCase()).changed(
        receipt.blockNumber.toString(),
      );
      return;
    }
    if (pending.attempts < 5) {
      await this.ctx.storage.put("pending", {
        ...pending,
        attempts: pending.attempts + 1,
      });
      try {
        await client.sendRawTransaction({ serializedTransaction: pending.raw });
      } catch {}
    }
    // Never discard an unknown nonce and accidentally replace someone else's action.
    await this.ctx.storage.setAlarm(Date.now() + 5000);
  }
  async alarm() {
    const next = this.queue.then(() => this.reconcile());
    this.queue = next.catch(() => {});
    await next;
  }
}

export default {
  async fetch(
    request: Request,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname;
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    if (path === "/api/rpc" && request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    const limited = await env.API_LIMIT.limit({
      key: `${request.headers.get("cf-connecting-ip") || "local"}:${path === "/api/rpc" ? "rpc" : "rooms"}`,
    });
    if (!limited.success)
      return json({ error: "请求过于频繁，请稍后重试" }, 429);
    try {
      if (path === "/api/config" && request.method === "GET") {
        const client = await checkNetwork(env),
          chain = client.chain;
        return json({
          network: {
            id: chain.id,
            name: chain.name,
            rpc: "/api/rpc",
            walletRpc: env.PUBLIC_RPC_URL,
            nativeCurrency: chain.nativeCurrency,
            explorer:
              env.NETWORK === "local" ? null : "https://testnet.monadscan.com",
          },
          localTestWallet: false,
          roomApi: true,
          roomSocket: true,
          relay:
            env.SPONSOR_ENABLED === "true" && !!env.RELAY_KEYS
              ? "/api/relay"
              : null,
          generation: `${chain.id}`,
        });
      }
      if (path === "/api/rpc" && request.method === "POST") {
        const response = json(await proxyRPC(env, await boundedJSON(request)));
        for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
        return response;
      }
      // No development funding, account impersonation or privileged RPC is present in this Worker.
      if (
        request.headers.has("origin") &&
        request.headers.get("origin") !== url.origin
      )
        throw new PublicError("来源不匹配", 403);
      const directory = env.DIRECTORY.getByName("directory-v1");
      if (path === "/api/rooms" && request.method === "GET")
        return json({ rooms: await directory.list() });
      const roomLookup = path.match(/^\/api\/rooms\/(0x[0-9a-fA-F]{40})$/);
      if (roomLookup && request.method === "GET") {
        const room = await directory.get(roomLookup[1]);
        return room ? json(room) : json({ error: "对局未登记" }, 404);
      }
      if (path === "/api/rooms" && request.method === "POST")
        return json(
          await directory.register(
            await verifyRoom(env, await boundedJSON(request, 4000)),
          ),
        );
      const roomPath = path.match(
        /^\/api\/rooms\/(0x[0-9a-fA-F]{40})\/(socket|notify)$/,
      );
      if (roomPath) {
        const address = roomPath[1].toLowerCase(),
          room = await directory.get(address);
        if (!room) throw new PublicError("房间未登记", 404);
        const hub = env.ROOMS.getByName(address);
        if (roomPath[2] === "socket" && request.method === "GET")
          return hub.fetch(request);
        if (roomPath[2] === "notify" && request.method === "POST") {
          const { hash } = (await boundedJSON(request, 300)) as {
            hash?: string;
          };
          if (!hashPattern.test(hash || ""))
            throw new PublicError("交易哈希无效");
          const receipt = await publicClient(env).getTransactionReceipt({
            hash: hash as Hex,
          });
          if (
            receipt.status !== "success" ||
            receipt.to?.toLowerCase() !== address
          )
            throw new PublicError("交易与房间不匹配");
          ctx.waitUntil(hub.changed(receipt.blockNumber.toString()));
          return json({ ok: true });
        }
      }
      if (path === "/api/relay" && request.method === "POST") {
        if (env.SPONSOR_ENABLED !== "true" || !env.RELAY_KEYS)
          throw new PublicError("赞助未启用", 503);
        const input = relayInput(await boundedJSON(request, 4000));
        if (!(await directory.get(input.address)))
          throw new PublicError("房间未登记", 404);
        const lane = input.action.zone ?? 0;
        const result = await env.SPONSORS.getByName(`lane-${lane}`).submit(
          lane,
          input,
        );
        return json(result, result.ok ? 200 : result.status);
      }
      return json({ error: "接口不存在" }, 404);
    } catch (error) {
      if (error instanceof PublicError)
        return json({ error: error.message }, error.status);
      // RPC provider errors may contain private endpoint credentials; never return or log their full text.
      console.warn(
        JSON.stringify({
          event: "request_failed",
          path,
          requestId: crypto.randomUUID(),
        }),
      );
      return json(
        { error: "链上服务暂不可用，操作未被确认。请同步后核对交易记录。" },
        503,
      );
    }
  },
} satisfies ExportedHandler<Bindings>;
