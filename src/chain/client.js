import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  isAddress,
  getAddress,
  keccak256,
  toHex,
  decodeEventLog,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import artifact from "./contract.json" with { type: "json" };
import {
  artifacts,
  detectMode,
  detectDuration,
  matchesCreation,
} from "./verify.js";
import { unpack, ZERO } from "../game/rules.js";

export const abi = artifact.abi;
export const ACTION_TYPES = {
  GameAction: [
    { name: "matchId", type: "bytes32" },
    { name: "rulesHash", type: "bytes32" },
    { name: "player", type: "address" },
    { name: "nonce", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "sessionVersion", type: "uint32" },
    { name: "action", type: "uint8" },
    { name: "tile", type: "uint8" },
    { name: "kind", type: "uint8" },
  ],
};
export const STANDARD_ACTION_TYPES = {
  GameAction: [
    ...ACTION_TYPES.GameAction.slice(0, 7),
    { name: "zone", type: "uint8" },
    ...ACTION_TYPES.GameAction.slice(7),
  ],
};
const privateCache = new Map();
const model = (context, address) =>
  artifacts[context.games?.get(address.toLowerCase()) || "practice"];
const safeRead = (key) => {
  try {
    return JSON.parse(sessionStorage.getItem(key) || "null");
  } catch {
    return null;
  }
};
const safeWrite = (key, value) => {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

export async function configuration() {
  {
    const res = await fetch("/api/config").catch(() => null);
    if (res?.headers.get("content-type")?.includes("application/json")) {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "链上服务不可用");
      return data;
    }
    if (import.meta.env.DEV) throw new Error("链上服务不可用");
  }
  const url = import.meta.env.VITE_MONAD_RPC_URL;
  if (!url) throw new Error("此预览尚未配置链上网络。");
  return {
    network: {
      id: 10143,
      name: "Monad Testnet",
      rpc: url,
      nativeCurrency: { name: "Test MON", symbol: "MON", decimals: 18 },
      explorer: "https://testnet.monadscan.com",
    },
    localTestWallet: false,
    relay: import.meta.env.VITE_RELAY_URL || null,
    generation: "testnet",
  };
}
export function clients(config) {
  const rpcUrl = new URL(config.network.rpc, window.location.origin).href;
  const chain = defineChain({
    id: config.network.id,
    name: config.network.name,
    nativeCurrency: config.network.nativeCurrency,
    rpcUrls: { default: { http: [rpcUrl] } },
    testnet: true,
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, {
      batch: { batchSize: 20, wait: 10 },
      retryCount: 1,
      timeout: 12000,
    }),
    pollingInterval: 1200,
  });
  return { chain, rpcUrl, publicClient, config, games: new Map() };
}
export async function connectTemporary(context) {
  if (
    !import.meta.env.DEV ||
    !context.config.localTestWallet ||
    context.chain.id !== 31337
  )
    throw new Error("临时钱包仅可用于本机测试链");
  const storageKey = `nadwars.local-wallet.v1:${context.config.generation}`;
  let key = safeRead(storageKey)?.privateKey;
  if (!key) {
    key = generatePrivateKey();
    safeWrite(storageKey, { privateKey: key });
  }
  const account = privateKeyToAccount(key);
  const res = await fetch("/api/dev/fund", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  if (!res.ok) throw new Error((await res.json()).error || "无法准备测试钱包");
  safeWrite(`${storageKey}:connected`, true);
  return {
    address: account.address,
    account,
    local: true,
    name: "临时测试钱包",
    provider: null,
    client: createWalletClient({
      account,
      chain: context.chain,
      transport: http(context.rpcUrl),
    }),
  };
}
export function restoreTemporary(context) {
  if (
    !import.meta.env.DEV ||
    !context.config.localTestWallet ||
    context.chain.id !== 31337
  )
    return null;
  if (
    safeRead(
      `nadwars.local-wallet.v1:${context.config.generation}:connected`,
    ) === false
  )
    return null;
  const key = safeRead(
    `nadwars.local-wallet.v1:${context.config.generation}`,
  )?.privateKey;
  if (!key) return null;
  try {
    const account = privateKeyToAccount(key);
    return {
      address: account.address,
      account,
      local: true,
      name: "临时测试钱包",
      provider: null,
      client: createWalletClient({
        account,
        chain: context.chain,
        transport: http(context.rpcUrl),
      }),
    };
  } catch {
    return null;
  }
}
export function disconnectTemporary(context) {
  if (context?.config.localTestWallet)
    safeWrite(
      `nadwars.local-wallet.v1:${context.config.generation}:connected`,
      false,
    );
}
export async function switchNetwork(context, provider) {
  const desired = toHex(context.chain.id);
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: desired }],
    });
  } catch (error) {
    if (error.code !== 4902) throw error;
    // Wallet extensions need a full network endpoint, not a relative proxy path.
    const rpcUrl =
      context.chain.id === 31337
        ? "http://127.0.0.1:18547"
        : context.config.network.walletRpc || context.rpcUrl;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: desired,
          chainName: context.chain.name,
          nativeCurrency: context.chain.nativeCurrency,
          rpcUrls: [rpcUrl],
          ...(context.config.network.explorer
            ? { blockExplorerUrls: [context.config.network.explorer] }
            : {}),
        },
      ],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: desired }],
    });
  }
  if (
    Number(await provider.request({ method: "eth_chainId" })) !==
    context.chain.id
  )
    throw new Error("钱包尚未切换到当前对局网络");
}
export async function connectExtension(context, provider, name = "EVM 钱包") {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!accounts?.[0]) throw new Error("钱包没有返回可用地址");
  if (
    Number(await provider.request({ method: "eth_chainId" })) !==
    context.chain.id
  )
    await switchNetwork(context, provider);
  return {
    address: getAddress(accounts[0]),
    local: false,
    name,
    provider,
    client: createWalletClient({
      account: getAddress(accounts[0]),
      chain: context.chain,
      transport: custom(provider),
    }),
  };
}

export async function verifyGame(context, address) {
  if (!isAddress(address)) throw new Error("对局地址无效");
  const checked = getAddress(address);
  const code = await context.publicClient.getCode({ address: checked });
  const mode = detectMode(code);
  if (!mode) throw new Error("此地址不是已验证版本的 NadWars 合约");
  if (context.config.roomApi || context.config.localTestWallet) {
    const response = await fetch(`/api/rooms/${checked.toLowerCase()}`);
    if (!response.ok) throw new Error("缺少对局创建记录，请从房间列表进入");
    const room = await response.json();
    const [transaction, receipt] = await Promise.all([
      context.publicClient.getTransaction({ hash: room.transaction }),
      context.publicClient.getTransactionReceipt({ hash: room.transaction }),
    ]);
    if (
      !matchesCreation(transaction, mode) ||
      receipt.status !== "success" ||
      receipt.contractAddress?.toLowerCase() !== checked.toLowerCase()
    )
      throw new Error("对局的创建代码未通过验证");
  }
  context.games ||= new Map();
  context.games.set(checked.toLowerCase(), mode);
  context.durations ||= new Map();
  context.durations.set(checked.toLowerCase(), detectDuration(code, mode));
  return checked;
}
export async function snapshot(context, address) {
  if (!context.games?.has(address.toLowerCase()))
    await verifyGame(context, address);
  if (context.games.get(address.toLowerCase()) === "standard")
    return standardSnapshot(context, address);
  return practiceSnapshot(context, address);
}
function playerView(who, p, energy, session, timestamp) {
  const arriveAt = Number(p.arriveAt || 0);
  return {
    address: who,
    ...p,
    energy: Number(energy),
    storedEnergy: Number(p.energy),
    nextActionAt: Number(p.nextActionAt),
    energyAt: Number(p.energyAt),
    zone: Number(
      arriveAt && timestamp >= arriveAt ? p.destination : p.zone || 0,
    ),
    destination: Number(p.destination || 0),
    arriveAt,
    session: {
      key: session.key ?? session[0],
      expiresAt: Number(session.expiresAt ?? session[1]),
      version: Number(session.version ?? session[2]),
      mask: Number(session.allowedActions ?? session[3]),
    },
  };
}
async function standardSnapshot(context, address) {
  const block = await context.publicClient.getBlock({ blockTag: "latest" });
  const v = await context.publicClient.readContract({
    address,
    abi: artifacts.standard.abi,
    functionName: "matchView",
    blockNumber: block.number,
  });
  const timestamp = Number(block.timestamp);
  const finalizedBlock =
    Number(v.phase) === 4 && context.chain.id === 10143
      ? await context.publicClient
          .getBlock({ blockTag: "finalized" })
          .then((b) => b.number)
          .catch(() => null)
      : null;
  const zones = v.zones.map((z, index) => ({
    index,
    rawBoard: z.cells.map(Number),
    board: z.cells.map((c, i) => unpack(c, i, z.power1, z.power2)),
    power1: z.power1,
    power2: z.power2,
    scores: [Number(z.score1), Number(z.score2)],
    scoreAt: Number(z.scoreAt),
  }));
  return {
    address,
    mode: "standard",
    duration: context.durations?.get(address.toLowerCase()) || 180,
    finalizedBlock,
    zoneCount: 4,
    playerCount: 8,
    zones,
    ...zones[0],
    scores: [Number(v.score1), Number(v.score2)],
    phase: Number(v.phase),
    startAt: Number(v.startAt),
    endAt: Number(v.endAt),
    createdAt: Number(v.createdAt),
    rosterVersion: Number(v.rosterVersion),
    matchId: v.matchId,
    rulesHash: v.rulesHash,
    seats: v.seats,
    players: v.seats.map((who, i) =>
      who === ZERO
        ? null
        : playerView(
            who,
            v.players[i],
            v.energies[i],
            v.sessions[i],
            timestamp,
          ),
    ),
    blockNumber: block.number,
    blockHash: block.hash,
    parentHash: block.parentHash,
    timestamp,
    receivedAt: Date.now(),
  };
}
async function practiceSnapshot(context, address) {
  const client = context.publicClient;
  const block = await client.getBlock({ blockTag: "latest" });
  const read = (functionName, args = []) =>
    client.readContract({
      address,
      abi,
      functionName,
      args,
      blockNumber: block.number,
    });
  const [
    rawBoard,
    power1,
    power2,
    scores,
    phase,
    startAt,
    endAt,
    rosterVersion,
    seat1,
    seat2,
    matchId,
    rulesHash,
    createdAt,
  ] = await Promise.all([
    read("board"),
    read("power1"),
    read("power2"),
    read("scores"),
    read("phase"),
    read("startAt"),
    read("endAt"),
    read("rosterVersion"),
    read("seats", [0n]),
    read("seats", [1n]),
    read("matchId"),
    read("RULES_HASH"),
    read("createdAt"),
  ]);
  const seats = [seat1, seat2];
  const players = await Promise.all(
    seats.map(async (who) => {
      if (who === ZERO) return null;
      const [state, energy, session] = await Promise.all([
        read("playerState", [who]),
        read("energyOf", [who]),
        read("sessions", [who]),
      ]);
      return {
        address: who,
        ...state,
        energy: Number(energy),
        storedEnergy: Number(state.energy),
        nextActionAt: Number(state.nextActionAt),
        energyAt: Number(state.energyAt),
        nonce: state.nonce,
        session: {
          key: session[0],
          expiresAt: Number(session[1]),
          version: Number(session[2]),
          mask: Number(session[3]),
        },
      };
    }),
  );
  const result = {
    address,
    rawBoard: rawBoard.map(Number),
    board: rawBoard.map((v, i) => unpack(v, i, power1, power2)),
    power1,
    power2,
    scores: scores.map(Number),
    phase: Number(phase),
    startAt: Number(startAt),
    endAt: Number(endAt),
    rosterVersion: Number(rosterVersion),
    seats,
    players,
    matchId,
    rulesHash,
    createdAt: Number(createdAt),
    blockNumber: block.number,
    blockHash: block.hash,
    parentHash: block.parentHash,
    timestamp: Number(block.timestamp),
    receivedAt: Date.now(),
  };
  result.mode = "practice";
  result.duration = context.durations?.get(address.toLowerCase()) || 180;
  result.finalizedBlock =
    result.phase === 4 && context.chain.id === 10143
      ? await client
          .getBlock({ blockTag: "finalized" })
          .then((b) => b.number)
          .catch(() => null)
      : null;
  result.zoneCount = 1;
  result.playerCount = 2;
  result.players = result.players.map((p) =>
    p ? { ...p, zone: 0, destination: 0, arriveAt: 0 } : null,
  );
  result.zones = [
    {
      index: 0,
      rawBoard: result.rawBoard,
      board: result.board,
      power1,
      power2,
      scores: result.scores,
    },
  ];
  return result;
}
export async function receipt(context, hash, onState) {
  onState?.({ status: "pending", hash, text: "已提交，等待链上执行" });
  const result = await context.publicClient.waitForTransactionReceipt({
    hash,
    timeout: 90000,
    pollingInterval: 500,
  });
  if (result.status !== "success") {
    onState?.({ status: "failed", hash, text: "交易执行失败，游戏状态未改变" });
    throw Object.assign(new Error("交易执行失败，游戏状态未改变"), {
      transactionHash: hash,
    });
  }
  onState?.({
    status: "confirmed",
    hash,
    text: "链上已执行",
    blockNumber: result.blockNumber,
    gasUsed: result.gasUsed,
  });
  if (context.config.roomSocket && result.to)
    void fetch(`/api/rooms/${result.to.toLowerCase()}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash }),
    }).catch(() => {});
  return result;
}
export async function write(
  context,
  wallet,
  address,
  functionName,
  args,
  onState,
) {
  if (!wallet) throw new Error("请先连接钱包");
  const { request } = await context.publicClient.simulateContract({
    address,
    abi: model(context, address).abi,
    functionName,
    args,
    account: wallet.address,
  });
  onState?.({
    status: "signing",
    text: wallet.local ? "正在签署测试交易" : "请在钱包确认",
  });
  const hash = await wallet.client.writeContract({
    ...request,
    account: wallet.account || wallet.address,
  });
  return receipt(context, hash, onState);
}
export async function createGame(
  context,
  wallet,
  name,
  onState,
  mode = "standard",
) {
  const definition = artifacts[mode];
  if (!definition) throw new Error("对局模式无效");
  const id = keccak256(crypto.getRandomValues(new Uint8Array(32)));
  onState?.({ status: "signing", text: "正在创建链上对局" });
  const hash = await wallet.client.deployContract({
    abi: definition.abi,
    bytecode: definition.bytecode,
    args: [id],
    account: wallet.account || wallet.address,
    chain: context.chain,
  });
  const tx = await receipt(context, hash, onState);
  if (!tx.contractAddress) throw new Error("未找到新对局的合约地址");
  const room = {
    address: tx.contractAddress,
    name: name || "四区能源战",
    mode,
    deploymentBlock: tx.blockNumber.toString(),
    transaction: hash,
    createdAt: Date.now(),
  };
  if (context.config.roomApi || context.config.localTestWallet) {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(room),
    });
    if (!res.ok)
      throw new Error("合约已创建，但房间目录同步失败；请保留交易记录。");
  }
  return room;
}
export async function listRooms(context) {
  if (context.config.roomApi || context.config.localTestWallet) {
    const res = await fetch("/api/rooms");
    if (!res.ok) throw new Error("房间列表暂时不可用");
    return (await res.json()).rooms;
  }
  return [];
}
function sessionId(context, address, owner) {
  return `nadwars.session.v1:${context.chain.id}:${address.toLowerCase()}:${owner.toLowerCase()}`;
}
export function sessionAccount(context, address, owner) {
  const id = sessionId(context, address, owner);
  if (privateCache.has(id)) return privateCache.get(id);
  const saved = safeRead(id);
  if (!saved?.privateKey || saved.expiresAt * 1000 <= Date.now()) return null;
  const account = privateKeyToAccount(saved.privateKey);
  privateCache.set(id, account);
  return account;
}
export async function authorize(context, wallet, snap, onState) {
  const key = generatePrivateKey(),
    account = privateKeyToAccount(key);
  const expiresAt = BigInt(snap.timestamp + 1000);
  await write(
    context,
    wallet,
    snap.address,
    "authorizeSession",
    [account.address, expiresAt, snap.mode === "standard" ? 15 : 7],
    onState,
  );
  const id = sessionId(context, snap.address, wallet.address);
  privateCache.set(id, account);
  safeWrite(id, { privateKey: key, expiresAt: Number(expiresAt) });
  return account;
}
export function clearSession(context, address, owner) {
  const id = sessionId(context, address, owner);
  privateCache.delete(id);
  try {
    sessionStorage.removeItem(id);
  } catch {}
}
export async function performAction(
  context,
  wallet,
  snap,
  action,
  tile,
  kind,
  onState,
  zone = 0,
  forceDirect = false,
) {
  const player = snap.players.find(
    (x) => x?.address.toLowerCase() === wallet.address.toLowerCase(),
  );
  if (!player) throw new Error("请先加入本局");
  if (
    !forceDirect &&
    (context.config.localTestWallet || context.config.relay)
  ) {
    const account = sessionAccount(context, snap.address, wallet.address);
    if (
      !account ||
      account.address.toLowerCase() !== player.session.key.toLowerCase() ||
      player.session.expiresAt <= snap.timestamp
    )
      throw new Error("本局授权已过期或被撤销，请重新授权");
    const a = {
      player: wallet.address,
      nonce: player.nonce,
      deadline: BigInt(snap.timestamp + 60),
      sessionVersion: player.session.version,
      action,
      ...(snap.mode === "standard" ? { zone } : {}),
      tile,
      kind,
    };
    const signature = await account.signTypedData({
      domain: {
        name: "NadWars",
        version: snap.mode === "standard" ? "0.2" : "0.1",
        chainId: context.chain.id,
        verifyingContract: snap.address,
      },
      types: snap.mode === "standard" ? STANDARD_ACTION_TYPES : ACTION_TYPES,
      primaryType: "GameAction",
      message: { matchId: snap.matchId, rulesHash: snap.rulesHash, ...a },
    });
    onState?.({ status: "signing", text: "本局授权正在签署操作" });
    const intent = {
      contract: snap.address,
      player: wallet.address,
      nonce: a.nonce.toString(),
      deadline: a.deadline.toString(),
      fromBlock: snap.blockNumber.toString(),
      action,
      zone,
      tile,
      kind,
    };
    let response;
    try {
      response = await fetch(context.config.relay || "/api/relay", {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: snap.address,
          action: {
            ...a,
            nonce: a.nonce.toString(),
            deadline: a.deadline.toString(),
          },
          signature,
        }),
      });
    } catch (error) {
      onState?.({
        status: "uncertain",
        intent,
        text: "响应中断，正在按操作序号核对结果",
      });
      throw error;
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      onState?.({
        status: "uncertain",
        intent,
        text: "响应无法解析，正在核对链上结果",
      });
      throw error;
    }
    if (!response.ok) {
      if (response.status >= 500)
        onState?.({
          status: "uncertain",
          intent,
          text: "转发结果待核实，请等待同步",
        });
      throw new Error(data.error || "操作转发失败");
    }
    return receipt(context, data.hash, onState);
  }
  return write(
    context,
    wallet,
    snap.address,
    "act",
    snap.mode === "standard"
      ? [action, zone, tile, kind, player.nonce]
      : [action, tile, kind, player.nonce],
    onState,
  );
}

export async function loadEvents(context, address, fromBlock, toBlock) {
  if (BigInt(fromBlock) < 0n || toBlock - BigInt(fromBlock) > 20000n)
    throw new Error("回放起始区块无效或范围过大，请使用原始邀请链接。");
  const client = context.publicClient;
  const logs = [];
  const step = 500n;
  for (let start = BigInt(fromBlock); start <= toBlock; start += step) {
    const end = start + step - 1n > toBlock ? toBlock : start + step - 1n;
    logs.push(
      ...(await client.getLogs({ address, fromBlock: start, toBlock: end })),
    );
  }
  const unique = new Map();
  for (const log of logs) {
    try {
      const event = decodeEventLog({
        abi: model(context, address).abi,
        data: log.data,
        topics: log.topics,
      });
      if (
        event.eventName !== "ActionResolved" &&
        event.eventName !== "MatchStarted" &&
        event.eventName !== "SupportStarted" &&
        event.eventName !== "MatchSettled"
      )
        continue;
      unique.set(`${log.blockHash}:${log.transactionHash}:${log.logIndex}`, {
        ...log,
        ...event,
      });
    } catch {}
  }
  return [...unique.values()].sort(
    (a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex,
  );
}
