import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LightningIcon,
  HexagonIcon,
  WalletIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  CopyIcon,
  CheckIcon,
  UsersIcon,
  TimerIcon,
  HammerIcon,
  SwordIcon,
  WrenchIcon,
  CrosshairIcon,
  XIcon,
  LinkIcon,
  PlayIcon,
  PauseIcon,
  WarningCircleIcon,
  SignOutIcon,
  BroadcastIcon,
  ArrowClockwiseIcon,
  CaretRightIcon,
  InfoIcon,
  CircleNotchIcon,
} from "@phosphor-icons/react";
import {
  configuration,
  clients,
  connectTemporary,
  restoreTemporary,
  disconnectTemporary,
  connectExtension,
  switchNetwork,
  createGame,
  listRooms,
  write,
  authorize,
  sessionAccount,
  clearSession,
  performAction,
  snapshot as readChainSnapshot,
  loadEvents,
} from "./chain/client.js";
import { explainError } from "./chain/errors.js";
import { resolvePendingIntent } from "./chain/pending.js";
import { useMatch } from "./hooks/useMatch.js";
import { useRoomConnection } from "./hooks/useRoomConnection.js";
import { Battlefield } from "./components/Battlefield.jsx";
import { Warfront } from "./components/Warfront.jsx";
import {
  initialBoard,
  KIND,
  KIND_ASSET,
  COST,
  TEAM,
  ZONES,
  adjacentZones,
  effectiveZone,
  supportHint,
  ZERO,
  OBJECTIVES,
  maskCount,
  clock,
  shortAddress,
  tileLabel,
  actionHint,
} from "./game/rules.js";
import {
  replayMatchAt,
  replayPlayersAt,
  summarize,
  matchesReplay,
} from "./game/replay.js";

const PREVIEW = initialBoard();
const TOOLS = [
  { id: "build", label: "建造", icon: HammerIcon },
  { id: "attack", label: "进攻", icon: SwordIcon },
  { id: "repair", label: "修复", icon: WrenchIcon },
];
function urlRoom() {
  const p = new URLSearchParams(location.search),
    from = p.get("from") || "0";
  return {
    address: p.get("room") || "",
    from: /^(0x[0-9a-fA-F]{1,16}|[0-9]{1,16})$/.test(from) ? from : "0",
  };
}
function Button({
  children,
  busy = false,
  disabled = false,
  className = "",
  ...props
}) {
  return (
    <button
      {...props}
      disabled={disabled || busy}
      className={`button ${className}`}
    >
      {busy && <CircleNotchIcon size={20} className="spin" />}
      {children}
    </button>
  );
}
function Asset({ kind, team = 1, className = "" }) {
  return (
    <img
      className={`asset ${team === 2 ? "amber-asset" : ""} ${className}`}
      src={`/assets/${KIND_ASSET[kind] || "relay"}-violet.png`}
      alt=""
    />
  );
}

export function App() {
  const [config, setConfig] = useState(null),
    [configError, setConfigError] = useState(""),
    [epoch, setEpoch] = useState(0);
  const context = useMemo(() => (config ? clients(config) : null), [config]);
  const [wallet, setWallet] = useState(null),
    [providers, setProviders] = useState([]),
    [walletModal, setWalletModal] = useState(false),
    [wrongNetwork, setWrongNetwork] = useState(false);
  const [route, setRoute] = useState(urlRoom),
    [page, setPage] = useState("hall"),
    [rooms, setRooms] = useState([]),
    [roomsError, setRoomsError] = useState("");
  const [busy, setBusy] = useState(""),
    [feedback, setFeedback] = useState(""),
    [tx, setTx] = useState(null),
    [proof, setProof] = useState(false),
    [copied, setCopied] = useState("");
  const [selected, setSelected] = useState(23),
    [tool, setTool] = useState("build"),
    [buildKind, setBuildKind] = useState(2),
    [roomName, setRoomName] = useState("四区能源战"),
    [newMode, setNewMode] = useState("standard"),
    [zone, setZone] = useState(0),
    [overview, setOverview] = useState(true),
    [directWallet, setDirectWallet] = useState(false);
  const [tick, setTick] = useState(Date.now()),
    [replaySecond, setReplaySecond] = useState(180),
    [playing, setPlaying] = useState(false);
  const {
    state: rawState,
    events,
    error,
    loading,
    historyReady,
    historyError,
    refresh,
  } = useMatch(context, route.address, route.from);
  const state = useMemo(
    () =>
      rawState
        ? {
            ...rawState,
            ...rawState.zones[Math.min(zone, rawState.zoneCount - 1)],
            scores: rawState.scores,
            selectedZone: Math.min(zone, rawState.zoneCount - 1),
          }
        : null,
    [rawState, zone],
  );
  const duration =
    state?.endAt > state?.startAt
      ? state.endAt - state.startAt
      : state?.duration || 180;
  useEffect(() => {
    if (state?.address) {
      setReplaySecond(duration);
      setPlaying(false);
    }
  }, [state?.address, duration]);
  const roomConnection = useRoomConnection(context, route.address, refresh);
  const player = state?.players.find(
      (p) => p?.address.toLowerCase() === wallet?.address.toLowerCase(),
    ),
    team = player?.team || 0;
  const now = state
    ? state.timestamp + Math.min(3, (tick - state.receivedAt) / 1000)
    : 0;
  const currentZone = effectiveZone(player, now);
  const travelRemaining = Math.max(0, (player?.arriveAt || 0) - now);
  const phase =
    state?.phase === 0 && now >= state.createdAt + 600
      ? 6
      : state?.phase === 2 && now >= state.endAt
        ? 3
        : state?.phase;
  const seconds = state
    ? phase === 1
      ? state.startAt - now
      : state.endAt - now
    : 180;
  const cooldown = player ? Math.max(0, player.nextActionAt - now) : 0;
  const energy = player
    ? Math.min(
        120,
        player.energy +
          Math.max(
            0,
            Math.min(now, state.endAt) -
              Math.max(state.timestamp, state.startAt),
          ) *
            5,
      )
    : 0;
  const scores = state
    ? state.scores.map(
        (v, i) =>
          v +
          Math.max(
            0,
            Math.min(now, state.endAt) -
              Math.max(state.timestamp, state.startAt),
          ) *
            state.zones.reduce(
              (total, z) => total + maskCount(i ? z.power2 : z.power1),
              0,
            ),
      )
    : [0, 0];
  const session =
    context && wallet && state
      ? sessionAccount(context, state.address, wallet.address)
      : null;
  const usesSession =
    !directWallet && Boolean(config?.localTestWallet || config?.relay);
  const sessionValid = Boolean(
    !usesSession ||
    (session &&
      player?.session.key.toLowerCase() === session.address.toLowerCase() &&
      player.session.expiresAt > now),
  );
  const selectedCell = state?.board[selected];
  const actionBlock = state
    ? actionHint({
        board: state.board,
        selected,
        tool,
        buildKind,
        team,
        energy,
        cooldown,
        phase,
        travelRemaining,
        wrongZone: state.mode === "standard" && zone !== currentZone,
      })
    : "等待战场同步";
  const canAct = Boolean(
    state &&
    wallet &&
    team &&
    sessionValid &&
    !busy &&
    tx?.status !== "uncertain" &&
    !wrongNetwork &&
    !error &&
    !actionBlock,
  );
  const { stats, moments } = useMemo(
    () => summarize(events, player ? wallet?.address : undefined),
    [events, wallet?.address, player],
  );
  const replay = useMemo(
    () =>
      state?.endAt
        ? replayMatchAt(
            events,
            state.startAt,
            state.endAt,
            replaySecond,
            state.zoneCount,
          )
        : null,
    [events, state?.startAt, state?.endAt, state?.zoneCount, replaySecond],
  );
  const replayVerified = historyReady && matchesReplay(events, state);
  const replayPlayers = useMemo(
    () =>
      state
        ? replayPlayersAt(
            events,
            state.players,
            state.startAt,
            replaySecond,
            state.zoneCount,
          )
        : [],
    [events, state?.players, state?.startAt, state?.zoneCount, replaySecond],
  );
  const highlights = useMemo(() => {
    if (state?.mode !== "standard") return moments.slice(-4);
    const cut = moments.find((m) => m.lost),
      restored = moments.find(
        (m) => m.restored && (!cut || m.zone === cut.zone),
      );
    const selected = [
      cut,
      restored,
      ...moments.filter((m) => m.support).slice(-2),
    ].filter(Boolean);
    return selected.length ? selected : moments.slice(-4);
  }, [moments, state?.mode]);
  const settledEvent = events.find((e) => e.eventName === "MatchSettled");
  const settlementLabel =
    config?.network.id === 31337
      ? "本地已结算"
      : state?.finalizedBlock &&
          settledEvent &&
          state.finalizedBlock >= settledEvent.blockNumber
        ? "已最终确定"
        : "已执行 · 等待最终确认";

  useEffect(() => {
    if (!walletModal && !proof) return;
    const previous = document.activeElement;
    const dialog = document.querySelector(proof ? ".proof-drawer" : ".modal");
    const focusable = () => [
      ...dialog.querySelectorAll(
        'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]',
      ),
    ];
    focusable()[0]?.focus();
    const keydown = (e) => {
      if (e.key === "Escape") {
        setWalletModal(false);
        setProof(false);
      }
      if (e.key !== "Tab") return;
      const items = focusable(),
        first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus?.();
    };
  }, [walletModal, proof]);

  useEffect(() => {
    if (tx?.status !== "uncertain" || !context) return;
    let live = true;
    const check = async () => {
      try {
        if (!tx.hash && tx.intent) {
          const next = await readChainSnapshot(context, tx.intent.contract);
          const p = next.players.find(
            (p) => p?.address.toLowerCase() === tx.intent.player.toLowerCase(),
          );
          if (!p) return;
          const logs = await loadEvents(
            context,
            tx.intent.contract,
            tx.intent.fromBlock,
            next.blockNumber,
          );
          const resolved = resolvePendingIntent(
            tx.intent,
            logs,
            p.nonce,
            next.timestamp,
          );
          if (live && resolved) {
            setTx(resolved);
            await refresh();
          }
          return;
        }
        if (!tx.hash) return;
        const result = await context.publicClient.getTransactionReceipt({
          hash: tx.hash,
        });
        if (!live) return;
        setTx({
          status: result.status === "success" ? "confirmed" : "failed",
          hash: tx.hash,
          text:
            result.status === "success"
              ? "已核实：链上已执行"
              : "已核实：交易执行失败",
        });
        await refresh();
      } catch {
        /* Keep the transaction uncertain until a receipt is available. */
      }
    };
    void check();
    const timer = setInterval(check, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [tx?.status, tx?.hash, tx?.intent, context, refresh]);

  useEffect(() => {
    let live = true;
    setConfigError("");
    configuration()
      .then((c) => {
        if (live) setConfig(c);
      })
      .catch((e) => {
        if (live) setConfigError(explainError(e));
      });
    return () => {
      live = false;
    };
  }, [epoch]);
  useEffect(() => {
    if (context) setWallet((old) => old || restoreTemporary(context));
  }, [context]);
  useEffect(() => {
    const announce = (e) => {
      const d = e.detail;
      if (d?.provider && d.info?.uuid)
        setProviders((old) =>
          old.some((p) => p.info.uuid === d.info.uuid) ? old : [...old, d],
        );
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    if (window.ethereum)
      setProviders((old) =>
        old.length
          ? old
          : [
              {
                info: { uuid: "injected", name: "浏览器 EVM 钱包" },
                provider: window.ethereum,
              },
            ],
      );
    return () =>
      window.removeEventListener("eip6963:announceProvider", announce);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const pop = () => setRoute(urlRoom());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (!wallet?.provider || !context) return;
    const accounts = () => {
      setWallet(null);
      setFeedback("钱包账户已变化，请重新连接以确认身份。");
    };
    const chain = (id) => {
      setWrongNetwork(Number(id) !== context.chain.id);
      setFeedback("钱包网络已变化，请核对当前对局网络。");
    };
    wallet.provider.on?.("accountsChanged", accounts);
    wallet.provider.on?.("chainChanged", chain);
    return () => {
      wallet.provider.removeListener?.("accountsChanged", accounts);
      wallet.provider.removeListener?.("chainChanged", chain);
    };
  }, [wallet, context]);
  const refreshRooms = useCallback(async () => {
    if (!context) return;
    try {
      setRooms(await listRooms(context));
      setRoomsError("");
    } catch (e) {
      setRoomsError(explainError(e));
    }
  }, [context]);
  useEffect(() => {
    void refreshRooms();
    const t = setInterval(() => void refreshRooms(), 5000);
    return () => clearInterval(t);
  }, [refreshRooms]);
  useEffect(() => {
    if (!playing || phase !== 4) return;
    const t = setInterval(
      () =>
        setReplaySecond((s) => {
          if (s >= duration) {
            setPlaying(false);
            return duration;
          }
          return s + 1;
        }),
      1000,
    );
    return () => clearInterval(t);
  }, [playing, phase, duration]);
  function navigate(room = null) {
    const u = new URL(location.href);
    if (room) {
      u.searchParams.set("room", room.address);
      u.searchParams.set("from", String(room.deploymentBlock || 0));
    } else {
      u.searchParams.delete("room");
      u.searchParams.delete("from");
    }
    history.pushState({}, "", u);
    setRoute(urlRoom());
    setFeedback("");
    setSelected(23);
    setZone(0);
    setOverview(true);
    setPage("hall");
    setTx(null);
    setProof(false);
    setReplaySecond(180);
  }
  async function run(label, fn) {
    if (busy) return;
    if (tx?.status === "uncertain") {
      setFeedback("上一笔交易仍在核实，请稍候。");
      return;
    }
    setBusy(label);
    setFeedback("");
    setTx(null);
    try {
      await fn();
      await refresh();
      await refreshRooms();
    } catch (e) {
      setFeedback(explainError(e));
      setTx((old) =>
        old &&
        old.status !== "confirmed" &&
        old.status !== "failed" &&
        old.status !== "uncertain"
          ? {
              ...old,
              status: old.hash ? "uncertain" : "failed",
              text: old.hash
                ? "结果待核实，请查看链上记录"
                : "操作未完成，请同步后重试",
            }
          : old,
      );
    } finally {
      setBusy("");
    }
  }
  function connect(local, provider, name) {
    void run("wallet", async () => {
      const w = local
        ? await connectTemporary(context)
        : await connectExtension(context, provider, name);
      setWallet(w);
      setWrongNetwork(false);
      setWalletModal(false);
    });
  }
  function newGame() {
    if (!wallet) {
      setWalletModal(true);
      return;
    }
    void run("create", async () => {
      navigate(
        await createGame(
          context,
          wallet,
          roomName,
          setTx,
          state?.mode || newMode,
        ),
      );
    });
  }
  function join(t) {
    if (!wallet) {
      setWalletModal(true);
      return;
    }
    void run("join", () =>
      write(context, wallet, state.address, "join", [t], setTx),
    );
  }
  const ready = () =>
    void run("ready", () =>
      write(
        context,
        wallet,
        state.address,
        "setReady",
        [state.rosterVersion, state.rulesHash],
        setTx,
      ),
    );
  const permit = () =>
    void run("permit", () => authorize(context, wallet, state, setTx));
  const begin = () =>
    void run("start", () =>
      write(context, wallet, state.address, "start", [], setTx),
    );
  const finalize = () =>
    void run("finalize", () =>
      write(context, wallet, state.address, "finalize", [], setTx),
    );
  const revoke = () =>
    void run("revoke", async () => {
      await write(context, wallet, state.address, "revokeSession", [], setTx);
      clearSession(context, state.address, wallet.address);
      setFeedback("本局操作授权已撤销。");
    });
  function act() {
    if (!canAct) return;
    const k = tool === "build" ? (selectedCell.objective ? 3 : buildKind) : 0;
    void run("action", () =>
      performAction(
        context,
        wallet,
        state,
        { build: 0, attack: 1, repair: 2 }[tool],
        selected,
        k,
        setTx,
        zone,
        directWallet,
      ),
    );
  }
  function support(destination) {
    const hint = supportHint({
      player,
      destination,
      phase,
      now,
      energy,
      cooldown,
    });
    if (hint || busy || !sessionValid || wrongNetwork || error) return;
    void run("support", () =>
      performAction(
        context,
        wallet,
        state,
        3,
        0,
        0,
        setTx,
        destination,
        directWallet,
      ),
    );
  }
  async function copy(text, label = "已复制") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(""), 2200);
    } catch {
      setFeedback("无法访问剪贴板，请复制浏览器中的对局链接。");
    }
  }
  const goHistory = () => {
    if (route.address) navigate();
    setPage("history");
  };
  const actionText =
    tool === "build"
      ? `建造${selectedCell?.objective ? "目标中继" : KIND[buildKind]}`
      : tool === "attack"
        ? "进攻设施"
        : "修复设施";
  const cost =
    tool === "build"
      ? COST[selectedCell?.objective ? 3 : buildKind]
      : tool === "attack"
        ? 18
        : 12;
  const room = rooms.find(
    (r) => r.address.toLowerCase() === route.address.toLowerCase(),
  );
  return (
    <div className="app-shell">
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate();
          }}
        >
          <HexagonIcon weight="duotone" className="brand-mark" />
          <span>
            Nad<span>Wars</span>
          </span>
        </a>
        {state && phase >= 1 && phase <= 3 ? (
          <div className="live-score">
            <span className="purple">
              紫电队 <b>{Math.floor(scores[0])}</b>
            </span>
            <div className="match-clock">
              {clock(seconds)}
              <small>{phase === 1 ? "开局倒计时" : "剩余时间"}</small>
            </div>
            <span className="amber">
              琥珀队 <b>{Math.floor(scores[1])}</b>
            </span>
          </div>
        ) : (
          <nav className="topnav">
            <button
              className={page === "hall" ? "active" : ""}
              onClick={() => navigate()}
            >
              对战大厅
            </button>
            <button
              className={page === "history" ? "active" : ""}
              onClick={goHistory}
            >
              最近对局
            </button>
          </nav>
        )}
        <div className="header-right">
          <span className={`network-tag ${configError ? "bad" : ""}`}>
            <BroadcastIcon weight="fill" />
            {config?.network.name || "连接网络中"}
          </span>
          <button
            className="wallet-button"
            onClick={() => setWalletModal(true)}
          >
            <WalletIcon />
            {wallet ? shortAddress(wallet.address) : "连接钱包"}
          </button>
        </div>
      </header>
      {(feedback || error || configError || wrongNetwork) && (
        <div className="notice" role="status">
          <WarningCircleIcon size={20} />
          <span>
            {wrongNetwork
              ? "钱包网络与对局不一致，请切换网络。"
              : feedback || error || configError}
          </span>
          {wrongNetwork ? (
            <button
              onClick={() =>
                void run("network", async () => {
                  await switchNetwork(context, wallet.provider);
                  setWrongNetwork(false);
                })
              }
            >
              切换网络
            </button>
          ) : configError ? (
            <button onClick={() => setEpoch((x) => x + 1)}>重试连接</button>
          ) : (
            <button
              onClick={() => {
                setFeedback("");
                void refresh();
              }}
            >
              重新同步
            </button>
          )}
        </div>
      )}
      {!route.address ? (
        <main className="lobby">
          <section className="lobby-hero">
            <div className="eyebrow">
              <span />
              ONCHAIN TACTICS · 四区协同
            </div>
            <h1>
              {page === "history" ? (
                "每一场战局，都有迹可循。"
              ) : (
                <>
                  接通能源，
                  <br />
                  改变战局。
                </>
              )}
            </h1>
            <p className="hero-lead">
              建造线路，切断供电。和对手在同一张链上地图中，争夺下一秒的优势。
            </p>
            <div className="lobby-map">
              <Warfront
                zones={Array.from(
                  { length: newMode === "standard" ? 4 : 1 },
                  (_, index) => ({
                    index,
                    board: PREVIEW,
                    power1: (1n << 21n) | (1n << 22n),
                    power2: (1n << 26n) | (1n << 27n),
                    scores: [0, 0],
                  }),
                )}
                zone={0}
                onZone={() => {}}
                overview
                onOverview={() => {}}
                interactive={false}
              />
              <span className="map-caption">初始地图 · 四区独立供电</span>
            </div>
            <div className="lobby-facts">
              <span>
                <UsersIcon />
                {newMode === "standard" ? 8 : 2} 人对战
              </span>
              <span>
                <HexagonIcon />
                {newMode === "standard"
                  ? "4 个战区 · 196 格"
                  : "1 个战区 · 49 格"}
              </span>
              <span>
                <TimerIcon />3 分钟一局
              </span>
            </div>
          </section>
          <aside className="lobby-panel">
            <div className="panel-kicker">
              {page === "history" ? "RECENT MATCHES" : "READY TO PLAY"}
            </div>
            <h2>{page === "history" ? "最近的链上对局" : "开始一场能源战"}</h2>
            {page !== "history" && (
              <>
                <p className="muted">组队守住供电线路，支援相邻战区。</p>
                <div className="mode-picker" aria-label="对局模式">
                  {[
                    ["standard", "八人标准战"],
                    ["practice", "双人练习"],
                  ].map(([m, label]) => (
                    <button
                      key={m}
                      className={newMode === m ? "active" : ""}
                      aria-pressed={newMode === m}
                      onClick={() => setNewMode(m)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="input-label" htmlFor="room-name">
                  房间名称
                </label>
                <input
                  id="room-name"
                  maxLength={30}
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  placeholder="四区能源战"
                />
                <Button
                  className="primary full"
                  onClick={newGame}
                  busy={busy === "create"}
                  disabled={!context || wrongNetwork}
                >
                  {wallet ? "创建链上房间" : "连接钱包开始"}
                  <ArrowRightIcon />
                </Button>
                <div className="quiet-note">
                  <InfoIcon />
                  每局规则由独立合约执行，游戏能源与 MON 手续费分开。
                </div>
              </>
            )}
            <div className="list-heading">
              <h3>{page === "history" ? "已创建的房间" : "加入已有房间"}</h3>
              <button
                aria-label="刷新房间列表"
                onClick={() => void refreshRooms()}
              >
                <ArrowClockwiseIcon />
              </button>
            </div>
            {roomsError ? (
              <p className="muted">{roomsError}</p>
            ) : rooms.length ? (
              <div className="room-list">
                {rooms.slice(0, page === "history" ? 12 : 4).map((r) => (
                  <button
                    className="room-row"
                    key={r.address}
                    onClick={() => navigate(r)}
                  >
                    <span className="room-icon">
                      <HexagonIcon weight="duotone" />
                    </span>
                    <span>
                      <strong>{r.name}</strong>
                      <small>
                        {shortAddress(r.address)} ·{" "}
                        {r.mode === "standard" ? "八人标准战" : "双人练习"}
                      </small>
                    </span>
                    <CaretRightIcon />
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-room">
                <UsersIcon size={30} />
                <p>还没有房间</p>
                <small>创建后，把邀请链接分享给队友与对手。</small>
              </div>
            )}
            <div className="lobby-guide">
              <span>
                <LightningIcon weight="fill" />
                连接发电站
              </span>
              <span>
                <CrosshairIcon />
                争夺目标点
              </span>
              <span>
                <WrenchIcon />
                修复与反击
              </span>
            </div>
          </aside>
        </main>
      ) : (loading || (!error && !configError)) && !state ? (
        <main className="loading-page">
          <CircleNotchIcon size={36} className="spin" />
          <h2>读取链上战场</h2>
          <p>正在核对合约版本与玩家状态…</p>
        </main>
      ) : !state ? (
        <main className="loading-page">
          <WarningCircleIcon size={40} />
          <h2>暂时无法打开这个对局</h2>
          <p>{error || "请确认网络连接与房间地址。"}</p>
          <Button onClick={() => navigate()}>
            <ArrowLeftIcon />
            返回大厅
          </Button>
        </main>
      ) : phase === 4 ? (
        <main className="result-page">
          <section className="result-main">
            <div className="result-title">
              <div>
                <span className="eyebrow">MATCH COMPLETE</span>
                <h1
                  className={
                    state.scores[0] === state.scores[1]
                      ? ""
                      : state.scores[0] > state.scores[1]
                        ? "purple"
                        : "amber"
                  }
                >
                  {state.scores[0] === state.scores[1]
                    ? "势均力敌 · 平局"
                    : `${state.scores[0] > state.scores[1] ? "紫电队" : "琥珀队"}胜利`}
                </h1>
                <p>每一次连接，都改变了战局。</p>
              </div>
              <div className="result-score">
                <span className="purple">{state.scores[0]}</span>
                <i>:</i>
                <span className="amber">{state.scores[1]}</span>
                <small>
                  对局时长 {clock(duration)} · {settlementLabel}
                </small>
              </div>
            </div>
            <div className="replay-title">
              <h3>关键时刻回放</h3>
              <span>
                {clock(replaySecond)} / {clock(duration)}
              </span>
            </div>
            <Warfront
              zones={replayVerified ? replay.zones : state.zones}
              players={replayVerified ? replayPlayers : state.players}
              now={replayVerified ? state.startAt + replaySecond : state.endAt}
              zone={zone}
              onZone={setZone}
              overview={overview}
              onOverview={setOverview}
              interactive={false}
            />
            <div className="replay-controls">
              <button
                className="play-control"
                aria-label={playing ? "暂停回放" : "播放回放"}
                disabled={!replayVerified}
                onClick={() => {
                  if (replaySecond >= duration) setReplaySecond(0);
                  setPlaying((x) => !x);
                }}
              >
                {playing ? (
                  <PauseIcon weight="fill" />
                ) : (
                  <PlayIcon weight="fill" />
                )}
              </button>
              <input
                aria-label="回放时间"
                type="range"
                disabled={!replayVerified}
                min="0"
                max={duration}
                value={replaySecond}
                onChange={(e) => {
                  setPlaying(false);
                  setReplaySecond(Number(e.target.value));
                }}
              />
              <span>{clock(replaySecond)}</span>
            </div>
            <div className="result-actions">
              <Button
                className="primary"
                onClick={newGame}
                busy={busy === "create"}
              >
                再来一局
                <ArrowRightIcon />
              </Button>
              <Button onClick={() => navigate()}>返回大厅</Button>
              <button className="text-button" onClick={() => setProof(true)}>
                查看链上记录
                <LinkIcon />
              </button>
            </div>
          </section>
          <aside className="result-side">
            <div className="panel-kicker">TURNING POINTS</div>
            <h2>战局发生在这里</h2>
            {!replayVerified ? (
              <p className="muted">
                {historyError ||
                  (historyReady
                    ? "回放记录未与最终状态匹配，请使用完整邀请链接。当前展示链上最终地图。"
                    : "正在核对回放记录…")}
              </p>
            ) : moments.length ? (
              <div className="moments">
                {highlights.map(
                  ({
                    event,
                    restored,
                    lost,
                    tile,
                    zone: momentZone = 0,
                    support: travel,
                  }) => (
                    <button
                      key={`${event.transactionHash}:${event.logIndex}`}
                      className="moment"
                      onClick={() => {
                        setZone(momentZone);
                        setOverview(false);
                        setReplaySecond(
                          Number(event.args.timestamp) - state.startAt,
                        );
                      }}
                    >
                      <span className="moment-time">
                        {clock(Number(event.args.timestamp) - state.startAt)}
                      </span>
                      <strong>
                        {travel
                          ? "队员跨区支援"
                          : restored
                            ? "供电重新接通"
                            : "前线供电中断"}
                      </strong>
                      <p>
                        {state.mode === "standard"
                          ? `${ZONES[momentZone]} · `
                          : ""}
                        {travel ? "5 秒转移" : tileLabel(tile)} ·{" "}
                        {travel
                          ? "保留能源与阵营"
                          : restored
                            ? `${restored} 座设施恢复运转`
                            : `${lost} 座设施失去供电`}
                      </p>
                    </button>
                  ),
                )}
              </div>
            ) : (
              <p className="muted">本局没有发生线路断电与恢复事件。</p>
            )}
            <div className="contribution">
              <h3>{player ? "你的贡献" : "全场操作"}</h3>
              <div>
                <HammerIcon />
                <span>建造设施</span>
                <b>
                  {replayVerified ? stats.build : "—"}
                  <small> 次</small>
                </b>
              </div>
              <div>
                <SwordIcon />
                <span>发起进攻</span>
                <b>
                  {replayVerified ? stats.attack : "—"}
                  <small> 次</small>
                </b>
              </div>
              <div>
                <WrenchIcon />
                <span>修复设施</span>
                <b>
                  {replayVerified ? stats.repair : "—"}
                  <small> 次</small>
                </b>
              </div>
              <div>
                <LightningIcon />
                <span>恢复供电</span>
                <b>
                  {replayVerified ? stats.restored : "—"}
                  <small> 次</small>
                </b>
              </div>
              {state.mode === "standard" && (
                <div>
                  <ArrowRightIcon />
                  <span>跨区支援</span>
                  <b>
                    {replayVerified ? stats.support : "—"}
                    <small> 次</small>
                  </b>
                </div>
              )}
            </div>
            <p className="quiet-note">
              成绩来自合约结算。回放按成功交易重建，贡献统计不改变胜负。
            </p>
          </aside>
        </main>
      ) : (
        <main className="arena">
          <section className="arena-main">
            <div className="arena-subbar">
              <button className="text-button" onClick={() => navigate()}>
                <ArrowLeftIcon />
                对战大厅
              </button>
              <span>
                <HexagonIcon />
                {state.mode === "standard"
                  ? "四战区 · 八人标准战"
                  : "北区 · 双人练习"}
              </span>
              <button
                className="text-button"
                onClick={() => void copy(location.href, "邀请链接已复制")}
              >
                <CopyIcon />
                {copied || "邀请对手"}
              </button>
            </div>
            <Warfront
              zones={state.zones}
              players={state.players}
              now={now}
              viewer={player}
              zone={zone}
              onZone={setZone}
              overview={overview}
              onOverview={setOverview}
              selected={selected}
              onSelect={setSelected}
              team={team}
            />
            {phase === 1 && (
              <div className="countdown-overlay">
                <span>双方就绪</span>
                <strong>{Math.max(0, Math.ceil(seconds))}</strong>
                <p>准备接通你的第一条线路</p>
              </div>
            )}
            <div className="command-dock">
              <div className="energy-readout">
                <LightningIcon weight="fill" />
                <strong>{Math.floor(energy)}</strong>
                <span>
                  能源<small>/ 120</small>
                </span>
              </div>
              <div className="tools">
                {TOOLS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    className={tool === id ? "selected" : ""}
                    onClick={() => setTool(id)}
                    aria-pressed={tool === id}
                  >
                    <Icon size={26} weight={tool === id ? "fill" : "regular"} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              <div className="dock-hint">
                {phase === 0
                  ? "双方加入并准备后，即可开始。"
                  : phase === 3
                    ? "对局结束，等待链上结算。"
                    : tool === "build"
                      ? "连接己方能源，向目标点扩张。"
                      : tool === "attack"
                        ? "切断连接，让对手的前线停机。"
                        : "修复连接，让前线重新亮起。"}
              </div>
            </div>
          </section>
          <aside className="arena-sidebar">
            {phase === 0 || phase === 1 ? (
              <>
                <div className="panel-kicker">MATCH LOBBY</div>
                <h2>
                  {room?.name ||
                    (state.mode === "standard" ? "四区能源战" : "双人能源战")}
                </h2>
                <p className="muted">
                  {state.players.filter(Boolean).length} / {state.playerCount}{" "}
                  位玩家已加入
                </p>
                <div
                  className={`team-roster ${state.mode === "standard" ? "eight-roster" : ""}`}
                >
                  {[1, 2].map((t) => (
                    <section className={`roster-team team-${t}`} key={t}>
                      <h3>
                        {TEAM[t]}{" "}
                        <small>
                          {state.players.filter((p) => p?.team === t).length}/
                          {state.playerCount / 2}
                        </small>
                      </h3>
                      {Array.from(
                        { length: state.playerCount / 2 },
                        (_, seat) => {
                          const index =
                              (t - 1) * (state.playerCount / 2) + seat,
                            p = state.players[index];
                          return (
                            <div className="roster-row" key={index}>
                              <span className="seat-zone">
                                {state.mode === "standard"
                                  ? ZONES[seat]
                                  : "北区"}
                              </span>
                              <span>
                                <strong>
                                  {p ? shortAddress(p.address) : "等待加入"}
                                </strong>
                                {p?.address.toLowerCase() ===
                                  wallet?.address.toLowerCase() && (
                                  <small>你</small>
                                )}
                              </span>
                              {p?.ready ? (
                                <CheckIcon className="ready-check" />
                              ) : (
                                <span className="not-ready">
                                  {p ? "未准备" : "空席"}
                                </span>
                              )}
                            </div>
                          );
                        },
                      )}
                    </section>
                  ))}
                </div>
                {!wallet ? (
                  <Button
                    className="primary full"
                    onClick={() => setWalletModal(true)}
                  >
                    连接钱包
                  </Button>
                ) : !player ? (
                  <div className="join-actions">
                    <Button
                      className="primary full"
                      disabled={
                        state.players.filter((p) => p?.team === 1).length >=
                          state.playerCount / 2 ||
                        phase !== 0 ||
                        wrongNetwork
                      }
                      busy={busy === "join"}
                      onClick={() => join(1)}
                    >
                      加入紫电队
                    </Button>
                    <Button
                      className="amber-button full"
                      disabled={
                        state.players.filter((p) => p?.team === 2).length >=
                          state.playerCount / 2 ||
                        phase !== 0 ||
                        wrongNetwork
                      }
                      busy={busy === "join"}
                      onClick={() => join(2)}
                    >
                      加入琥珀队
                    </Button>
                  </div>
                ) : phase === 0 ? (
                  <>
                    {!sessionValid && usesSession ? (
                      <>
                        <Button
                          className="primary full"
                          busy={busy === "permit"}
                          onClick={permit}
                        >
                          授权本局操作
                        </Button>
                        <p className="quiet-note">
                          仅允许本局建造、进攻、修复
                          {state.mode === "standard" ? "和支援" : ""}
                          ，到期失效。
                        </p>
                      </>
                    ) : !player.ready ? (
                      <Button
                        className="primary full"
                        busy={busy === "ready"}
                        onClick={ready}
                      >
                        准备就绪
                        <CheckIcon />
                      </Button>
                    ) : state.players.every((p) => p?.ready) ? (
                      <Button
                        className="primary full"
                        busy={busy === "start"}
                        onClick={begin}
                      >
                        开始对局
                        <PlayIcon weight="fill" />
                      </Button>
                    ) : (
                      <Button className="full" disabled>
                        等待对手准备
                      </Button>
                    )}
                    <button
                      className="text-button leave-button"
                      disabled={!!busy}
                      onClick={() =>
                        void run("leave", () =>
                          write(
                            context,
                            wallet,
                            state.address,
                            "leave",
                            [],
                            setTx,
                          ),
                        )
                      }
                    >
                      <SignOutIcon />
                      离开房间
                    </button>
                  </>
                ) : (
                  <p className="muted">名单已锁定，即将开始。</p>
                )}
                <div className="instruction-list">
                  <h3>如何赢下这一局</h3>
                  <p>
                    <span>01</span>从发电站延伸己方线路
                  </p>
                  <p>
                    <span>02</span>接通目标点，持续获得积分
                  </p>
                  <p>
                    <span>03</span>破坏敌方线路，守住自己的供电
                  </p>
                </div>
              </>
            ) : phase === 3 ? (
              <>
                <div className="panel-kicker">TIME'S UP</div>
                <h2>战斗结束</h2>
                <Asset kind={1} />
                <p className="muted">
                  计分已在第 {duration} 秒停止。完成结算后即可查看结果和回放。
                </p>
                <Button
                  className="primary full"
                  busy={busy === "finalize"}
                  disabled={!wallet || wrongNetwork}
                  onClick={finalize}
                >
                  结算并查看结果
                </Button>
                {!wallet && (
                  <button
                    className="text-button"
                    onClick={() => setWalletModal(true)}
                  >
                    连接钱包
                  </button>
                )}
              </>
            ) : phase === 5 || phase === 6 ? (
              <>
                <h2>{phase === 6 ? "房间已过期" : "房间已取消"}</h2>
                {phase === 6 && (
                  <p className="muted">
                    等待已超过 10 分钟，请回大厅创建新对局。
                  </p>
                )}
                <Button onClick={() => navigate()}>返回大厅</Button>
              </>
            ) : (
              <>
                {state.mode === "standard" && player && (
                  <div className="support-panel">
                    <div>
                      <strong>
                        {travelRemaining > 0
                          ? `前往${ZONES[player.destination]}`
                          : `你在${ZONES[currentZone]}`}
                      </strong>
                      <span>
                        {travelRemaining > 0
                          ? `${Math.ceil(travelRemaining)}s 后抵达`
                          : "支援耗时 5s"}
                      </span>
                    </div>
                    <div className="support-routes">
                      {ZONES.map(
                        (label, destination) =>
                          adjacentZones(currentZone, destination) && (
                            <button
                              key={destination}
                              onClick={() => support(destination)}
                              disabled={
                                !!supportHint({
                                  player,
                                  destination,
                                  phase,
                                  now,
                                  energy,
                                  cooldown,
                                }) ||
                                !!busy ||
                                !sessionValid ||
                                wrongNetwork ||
                                !!error
                              }
                              title={
                                supportHint({
                                  player,
                                  destination,
                                  phase,
                                  now,
                                  energy,
                                  cooldown,
                                }) || "消耗 25 能源"
                              }
                            >
                              支援{label}
                              <ArrowRightIcon />
                              <small>25 能源</small>
                            </button>
                          ),
                      )}
                    </div>
                  </div>
                )}
                <div className="selection-heading">
                  <span>{tileLabel(selected)}</span>
                  <small>格子 {selected}</small>
                </div>
                <h2>
                  {selectedCell?.kind
                    ? KIND[selectedCell.kind]
                    : selectedCell?.objective
                      ? "中立能源目标"
                      : "可建设空地"}
                </h2>
                <Asset
                  kind={
                    selectedCell?.kind ||
                    (selectedCell?.objective ? 3 : buildKind)
                  }
                  team={selectedCell?.team || team || 1}
                  className={
                    !selectedCell?.powered && selectedCell?.kind
                      ? "offline"
                      : ""
                  }
                />
                <div
                  className={`facility-state ${selectedCell?.powered ? "powered" : "offline-state"}`}
                >
                  <span />
                  {selectedCell?.kind
                    ? selectedCell.powered
                      ? "供电正常"
                      : "供电中断"
                    : selectedCell?.objective
                      ? "接通后每秒产生 1 积分"
                      : "选择设施，延伸你的线路"}
                </div>
                {selectedCell?.kind > 0 && (
                  <div className="facility-stats">
                    <div>
                      <span>所属阵营</span>
                      <b
                        className={selectedCell.team === 1 ? "purple" : "amber"}
                      >
                        {TEAM[selectedCell.team]}
                      </b>
                    </div>
                    <div>
                      <span>耐久</span>
                      <b>
                        {selectedCell.kind === 1
                          ? "不可摧毁"
                          : `${selectedCell.hp} / ${selectedCell.maxHp}`}
                      </b>
                    </div>
                  </div>
                )}
                {tool === "build" &&
                  !selectedCell?.kind &&
                  !selectedCell?.objective && (
                    <div className="build-choices" aria-label="建造类型">
                      {[2, 4, 5].map((k) => (
                        <button
                          key={k}
                          className={buildKind === k ? "active" : ""}
                          onClick={() => setBuildKind(k)}
                        >
                          <Asset kind={k} />
                          <span>{KIND[k]}</span>
                          <small>{COST[k]} 能源</small>
                        </button>
                      ))}
                    </div>
                  )}
                <div className="cost-line">
                  <span>
                    <LightningIcon />
                    操作消耗
                  </span>
                  <strong>{cost} 能源</strong>
                </div>
                {player && !sessionValid && usesSession ? (
                  <Button
                    className="primary full"
                    busy={busy === "permit"}
                    onClick={permit}
                  >
                    重新授权本局操作
                  </Button>
                ) : (
                  <Button
                    className={`primary full ${team === 2 ? "amber-button" : ""}`}
                    busy={busy === "action"}
                    disabled={!canAct}
                    onClick={act}
                  >
                    {actionText}
                    <ArrowRightIcon />
                  </Button>
                )}
                <p className="action-hint">
                  {wrongNetwork
                    ? "请先切换钱包网络"
                    : actionBlock || "操作由合约验证，双方将看到同一结果。"}
                </p>
                <div className="objectives">
                  <h3>能源目标</h3>
                  {OBJECTIVES.map((i, n) => (
                    <button key={i} onClick={() => setSelected(i)}>
                      <span
                        className={`objective-dot team-${state.board[i].team} ${state.board[i].powered ? "lit" : ""}`}
                      />
                      <span>目标 {String.fromCharCode(65 + n)}</span>
                      <small>
                        {state.board[i].kind
                          ? state.board[i].powered
                            ? `${TEAM[state.board[i].team]} +1/s`
                            : "已占领 · 离线"
                          : "中立"}
                      </small>
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="sidebar-footer">
              <button className="text-button" onClick={() => setProof(true)}>
                <LinkIcon />
                链上记录
              </button>
              <small>
                {roomConnection === "live" ? "实时同步 · " : "自动同步 · "}区块{" "}
                {state.blockNumber.toString()}
              </small>
            </div>
          </aside>
        </main>
      )}
      {tx && (
        <div className={`transaction-toast ${tx.status}`} role="status">
          {tx.status === "confirmed" ? (
            <CheckIcon weight="bold" />
          ) : (
            <CircleNotchIcon className="spin" />
          )}
          <span>{tx.text}</span>
          {tx.hash && (
            <button onClick={() => setProof(true)}>
              {shortAddress(tx.hash)}
              <LinkIcon />
            </button>
          )}
          <button
            aria-label="关闭交易提示"
            disabled={tx.status === "uncertain"}
            onClick={() => setTx(null)}
          >
            <XIcon />
          </button>
        </div>
      )}
      <footer className="app-footer">
        <span>
          NadWars ·{" "}
          {state?.mode === "practice" ? "单战区双人练习" : "四战区八人标准战"}
        </span>
        <span>
          {!config
            ? "正在读取链上网络配置"
            : config.localTestWallet
              ? "本地 MonadTen · 真实本地合约交易"
              : "Monad 测试网 · 游戏能源不具备货币价值"}
        </span>
      </footer>
      {walletModal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setWalletModal(false);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wallet-title"
          >
            <button
              className="modal-close"
              aria-label="关闭钱包窗口"
              onClick={() => setWalletModal(false)}
            >
              <XIcon />
            </button>
            <WalletIcon className="modal-symbol" />
            <h2 id="wallet-title">{wallet ? "当前钱包" : "连接你的钱包"}</h2>
            {wallet ? (
              <>
                <p className="address-text">{wallet.address}</p>
                <p className="muted">
                  {wallet.name} · {config?.network.name}
                </p>
                {state && player && usesSession && (
                  <Button
                    className="full"
                    onClick={revoke}
                    busy={busy === "revoke"}
                    disabled={!sessionValid}
                  >
                    撤销本局授权
                  </Button>
                )}
                {(config?.localTestWallet || config?.relay) && (
                  <Button
                    className="full"
                    disabled={!!busy || tx?.status === "uncertain"}
                    onClick={() => setDirectWallet((v) => !v)}
                  >
                    {directWallet ? "使用本局授权操作" : "切换为钱包逐笔确认"}
                  </Button>
                )}
                <Button
                  className="full"
                  onClick={() => {
                    disconnectTemporary(context);
                    setWallet(null);
                    setWalletModal(false);
                    setWrongNetwork(false);
                  }}
                >
                  断开连接
                </Button>
              </>
            ) : (
              <>
                {providers.map(({ info, provider }) => (
                  <Button
                    key={info.uuid}
                    className="full"
                    busy={busy === "wallet"}
                    disabled={!context}
                    onClick={() => connect(false, provider, info.name)}
                  >
                    <WalletIcon />
                    {info.name}
                    <ArrowRightIcon />
                  </Button>
                ))}
                {!providers.length && (
                  <p className="muted">
                    未检测到浏览器钱包。可在安装了 EVM 钱包的浏览器中打开。
                  </p>
                )}
                {config?.localTestWallet && (
                  <>
                    <div className="modal-divider">本机开发验证</div>
                    <Button
                      className="primary full"
                      busy={busy === "wallet"}
                      onClick={() => connect(true)}
                    >
                      创建临时测试钱包
                    </Button>
                    <p className="quiet-note">
                      在本浏览器会话中生成独立钱包，仅使用本地测试币。另一个独立页面可作为第二位玩家。
                    </p>
                  </>
                )}
              </>
            )}
          </section>
        </div>
      )}
      {proof && (
        <div
          className="drawer-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setProof(false);
          }}
        >
          <aside
            className="proof-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="proof-title"
          >
            <button
              className="modal-close"
              aria-label="关闭链上记录"
              onClick={() => setProof(false)}
            >
              <XIcon />
            </button>
            <div className="panel-kicker">VERIFIABLE PLAY</div>
            <h2 id="proof-title">链上对局记录</h2>
            <p className="muted">
              {config?.network.name} ·{" "}
              {config?.localTestWallet
                ? "本机隔离链，未部署公网"
                : "公共测试网"}
            </p>
            {state && (
              <>
                <label>游戏合约</label>
                <button
                  className="copy-row"
                  onClick={() => void copy(state.address)}
                >
                  {shortAddress(state.address)}
                  <CopyIcon />
                </button>
                <label>规则版本</label>
                <div className="copy-row">
                  <span>
                    {state.mode === "standard"
                      ? "v0.2 · 四战区八人"
                      : "v0.1 · 双人单战区"}
                  </span>
                  <CheckIcon />
                </div>
                <label>成功操作</label>
                <strong className="proof-count">
                  {historyReady
                    ? events.filter((e) => e.eventName === "ActionResolved")
                        .length
                    : "—"}
                </strong>
              </>
            )}
            {tx?.hash && (
              <>
                <label>最近提交</label>
                <button className="copy-row" onClick={() => void copy(tx.hash)}>
                  {shortAddress(tx.hash)}
                  <CopyIcon />
                </button>
              </>
            )}
            <div className="proof-events">
              {events
                .slice()
                .reverse()
                .map((e) => (
                  <div key={`${e.transactionHash}:${e.logIndex}`}>
                    <div>
                      <strong>
                        {e.eventName === "MatchSettled"
                          ? "最终结算"
                          : e.eventName === "MatchStarted"
                            ? "双方开始对局"
                            : e.eventName === "SupportStarted"
                              ? `支援 ${ZONES[Number(e.args.fromZone)]} → ${ZONES[Number(e.args.toZone)]}`
                              : `${["建造", "进攻", "修复"][Number(e.args.action)]} ${tileLabel(Number(e.args.tile))}`}
                      </strong>
                      <small>区块 {e.blockNumber.toString()}</small>
                    </div>
                    <button onClick={() => void copy(e.transactionHash)}>
                      {shortAddress(e.transactionHash)}
                      <CopyIcon />
                    </button>
                    {config?.network.explorer && (
                      <a
                        href={`${config.network.explorer}/tx/${e.transactionHash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        在浏览器查看
                      </a>
                    )}
                  </div>
                ))}
            </div>
            {!events.length && (
              <p className="quiet-note">对局开始后的成功操作将在这里显示。</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
