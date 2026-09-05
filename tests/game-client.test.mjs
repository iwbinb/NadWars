import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialBoard,
  neighbors,
  actionHint,
  unpack,
  clock,
} from "../src/game/rules.js";
import { matchesRuntime } from "../src/chain/verify.js";
import artifact from "../src/chain/contract.json" with { type: "json" };
import { replayAt, summarize, matchesReplay } from "../src/game/replay.js";
import { switchNetwork } from "../src/chain/client.js";
import { performAction, STANDARD_ACTION_TYPES } from "../src/chain/client.js";
import { resolvePendingIntent } from "../src/chain/pending.js";
import { artifacts, detectMode } from "../src/chain/verify.js";
import { effectiveZone, supportHint } from "../src/game/rules.js";
import { replayMatchAt, replayPlayersAt } from "../src/game/replay.js";

test("replay shows a support move at its historical departure and arrival", () => {
  const p = Array.from({ length: 8 }, (_, i) => ({
    address: `0x${String(i + 1).padStart(40, "0")}`,
  }));
  const e = {
    eventName: "SupportStarted",
    args: {
      player: p[0].address,
      fromZone: 0,
      toZone: 1,
      timestamp: 110n,
      arriveAt: 115n,
    },
  };
  assert.equal(replayPlayersAt([e], p, 100, 5)[0].zone, 0);
  assert.equal(replayPlayersAt([e], p, 100, 12)[0].arriveAt, 115);
  assert.equal(replayPlayersAt([e], p, 100, 15)[0].zone, 1);
  assert.equal(replayPlayersAt([e], p, 100, 15)[0].arriveAt, 0);
});

test("standard mode and signed actions bind the selected zone", () => {
  assert.equal(detectMode(artifacts.standard.runtime), "standard");
  assert.equal(detectMode(artifacts.practice.runtime), "practice");
  assert.deepEqual(
    STANDARD_ACTION_TYPES.GameAction.slice(-4).map((x) => x.name),
    ["action", "zone", "tile", "kind"],
  );
});
test("support hints preserve the old zone in transit and resolve arrival lazily", () => {
  const player = { zone: 0, destination: 1, arriveAt: 105 };
  assert.equal(effectiveZone(player, 104), 0);
  assert.equal(effectiveZone(player, 105), 1);
  assert.match(
    supportHint({
      player,
      destination: 2,
      phase: 2,
      now: 104,
      energy: 100,
      cooldown: 0,
    }),
    /途中/,
  );
  assert.match(
    supportHint({
      player,
      destination: 2,
      phase: 2,
      now: 105,
      energy: 100,
      cooldown: 0,
    }),
    /相邻/,
  );
  assert.equal(
    supportHint({
      player,
      destination: 3,
      phase: 2,
      now: 105,
      energy: 100,
      cooldown: 0,
    }),
    "",
  );
});
test("four-zone replay does not overwrite another zone's cell or score", () => {
  const base = (1n << 21n) | (1n << 22n),
    power2 = (1n << 26n) | (1n << 27n),
    player = "0x" + "11".repeat(20);
  const make = (zone, timestamp) => ({
    eventName: "ActionResolved",
    args: {
      zone,
      player,
      action: 0,
      tile: 24,
      cellAfter: 3 | (1 << 8) | (100 << 16),
      timestamp: BigInt(timestamp),
      power1: base | (1n << 24n),
      power2,
    },
  });
  const replay = replayMatchAt([make(0, 110), make(1, 120)], 100, 340, 240, 4);
  assert.deepEqual(replay.scores, [450, 0]);
  assert.equal(replay.zones[2].board[24].kind, 0);
  assert.deepEqual(
    replay.zones.map((z) => z.scores[0]),
    [230, 220, 0, 0],
  );
});
test("lost responses remain uncertain until an exact event or expired unused nonce is observed", () => {
  const intent = {
    player: "0x" + "11".repeat(20),
    nonce: "3",
    action: 0,
    zone: 2,
    tile: 24,
    kind: 3,
    deadline: "150",
  };
  assert.equal(resolvePendingIntent(intent, [], 3n, 150), null);
  assert.equal(resolvePendingIntent(intent, [], 4n, 151), null);
  assert.equal(resolvePendingIntent(intent, [], 3n, 151).status, "failed");
  const event = {
    eventName: "ActionResolved",
    transactionHash: "0xabc",
    args: {
      player: intent.player,
      nonce: 3n,
      action: 0,
      zone: 2,
      tile: 24,
      cellAfter: 3 | (1 << 8) | (100 << 16),
    },
  };
  assert.equal(
    resolvePendingIntent(intent, [event], 4n, 140).status,
    "confirmed",
  );
  assert.equal(
    resolvePendingIntent({ ...intent, zone: 1 }, [event], 4n, 140).status,
    "failed",
  );
  assert.equal(
    resolvePendingIntent({ ...intent, kind: 2 }, [event], 4n, 140).status,
    "failed",
  );
});
test("direct-wallet fallback sends a standard action without requiring a session relay", async () => {
  const address = "0x" + "11".repeat(20),
    owner = "0x" + "22".repeat(20);
  let request;
  const context = {
    games: new Map([[address, "standard"]]),
    config: { relay: "/api/relay" },
    publicClient: {
      simulateContract: async (r) => ({ request: r }),
      waitForTransactionReceipt: async () => ({
        status: "success",
        blockNumber: 1n,
        gasUsed: 1n,
      }),
    },
  };
  const wallet = {
    address: owner,
    client: {
      writeContract: async (r) => {
        request = r;
        return "0xabc";
      },
    },
  };
  await performAction(
    context,
    wallet,
    { address, mode: "standard", players: [{ address: owner, nonce: 7n }] },
    3,
    0,
    0,
    () => {},
    1,
    true,
  );
  assert.equal(request.functionName, "act");
  assert.deepEqual(request.args, [3, 1, 0, 0, 7n]);
});

test("new wallet networks are explicitly switched and verified after being added", async () => {
  let added = false,
    active = "0x1";
  const calls = [];
  const provider = {
    request: async ({ method, params }) => {
      calls.push(method);
      if (method === "wallet_switchEthereumChain") {
        if (!added)
          throw Object.assign(new Error("Unknown chain"), { code: 4902 });
        active = params[0].chainId;
      }
      if (method === "wallet_addEthereumChain") added = true;
      if (method === "eth_chainId") return active;
    },
  };
  const context = {
    chain: {
      id: 31337,
      name: "Local MonadTen",
      nativeCurrency: { name: "Test MON", symbol: "MON", decimals: 18 },
    },
    config: { network: {} },
    rpcUrl: "http://127.0.0.1:18547",
  };
  await switchNetwork(context, provider);
  assert.deepEqual(calls, [
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
    "wallet_switchEthereumChain",
    "eth_chainId",
  ]);
  await assert.rejects(
    () =>
      switchNetwork(context, {
        request: async ({ method }) =>
          method === "eth_chainId" ? "0x1" : undefined,
      }),
    /尚未切换/,
  );
});

test("initial board matches reactor/relay encoding and power", () => {
  const b = initialBoard();
  assert.equal(b.length, 49);
  for (const [i, k, t, h] of [
    [21, 1, 1, 1],
    [22, 2, 1, 100],
    [26, 2, 2, 100],
    [27, 1, 2, 1],
  ]) {
    assert.deepEqual(
      [b[i].kind, b[i].team, b[i].hp, b[i].powered],
      [k, t, h, true],
    );
  }
  assert.equal(b.filter((c) => c.objective).length, 3);
  assert.equal(b.filter((c) => c.kind).length, 4);
});

test("replay is unavailable when its start, settlement or final state is missing", () => {
  const state = {
    phase: 4,
    startAt: 100,
    endAt: 340,
    scores: [0, 0],
    rawBoard: initialBoard().map((c) => c.kind | (c.team << 8) | (c.hp << 16)),
    power1: (1n << 21n) | (1n << 22n),
    power2: (1n << 26n) | (1n << 27n),
  };
  const events = [
    { eventName: "MatchStarted", args: { startAt: 100n } },
    { eventName: "MatchSettled", args: { endAt: 340n } },
  ];
  assert.ok(matchesReplay(events, state));
  assert.ok(!matchesReplay(events.slice(1), state));
  assert.ok(!matchesReplay(events.slice(0, 1), state));
  assert.ok(!matchesReplay(events, { ...state, scores: [1, 0] }));
  assert.ok(
    !matchesReplay(events, {
      ...state,
      rawBoard: state.rawBoard.map((c, i) => (i === 23 ? 6553858 : c)),
    }),
  );
});
test("all client neighbor pairs are bounded and reciprocal", () => {
  for (let i = 0; i < 49; i++)
    for (const n of neighbors(i)) {
      assert.ok(n >= 0 && n < 49);
      assert.ok(neighbors(n).includes(i));
    }
  assert.ok(!neighbors(6).includes(7));
});
test("construction hints enforce powered adjacency and objective costs", () => {
  const board = initialBoard();
  const base = {
    board,
    team: 1,
    energy: 100,
    cooldown: 0,
    phase: 2,
    tool: "build",
    buildKind: 2,
  };
  assert.equal(actionHint({ ...base, selected: 23 }), "");
  assert.match(actionHint({ ...base, selected: 0 }), /邻接/);
  assert.match(actionHint({ ...base, selected: 22 }), /已有/);
  assert.match(actionHint({ ...base, selected: 23, energy: 14 }), /1 能源/);
});
test("attack, repair, cooldown and spectator hints are distinct", () => {
  const base = {
    board: initialBoard(),
    team: 1,
    energy: 120,
    cooldown: 0,
    phase: 2,
    buildKind: 2,
  };
  assert.match(actionHint({ ...base, selected: 21, tool: "attack" }), /敌方/);
  assert.match(
    actionHint({ ...base, selected: 22, tool: "repair" }),
    /耐久已满/,
  );
  assert.match(
    actionHint({ ...base, selected: 23, tool: "build", cooldown: 1.4 }),
    /2 秒/,
  );
  assert.match(
    actionHint({ ...base, selected: 23, tool: "build", team: 0 }),
    /加入/,
  );
  assert.equal(clock(-1), "00:00");
  assert.equal(clock(125), "02:05");
});
test("runtime verification rejects changed logic, permits immutable constructor fields", () => {
  assert.ok(matchesRuntime(artifact.runtime));
  assert.ok(!matchesRuntime("0x00"));
  const body = artifact.runtime.slice(2).split("");
  body[0] = body[0] === "0" ? "1" : "0";
  assert.ok(!matchesRuntime(`0x${body.join("")}`));
  const copy = artifact.runtime.slice(2).split(""),
    span = Object.values(artifact.immutableReferences)[0][0];
  copy.fill("f", span.start * 2, (span.start + span.length) * 2);
  assert.ok(matchesRuntime(`0x${copy.join("")}`));
});
test("replay integrates objective-seconds and does not count new construction as restoration", () => {
  const p = (1n << 21n) | (1n << 22n),
    a = "0x1111111111111111111111111111111111111111";
  const event = (timestamp, tile, cellAfter, power1) => ({
    eventName: "ActionResolved",
    args: {
      timestamp: BigInt(timestamp),
      tile,
      cellAfter,
      power1,
      power2: (1n << 26n) | (1n << 27n),
      action: 0,
      player: a,
    },
  });
  const es = [
    event(102, 23, 2 | (1 << 8) | (100 << 16), p | (1n << 23n)),
    event(110, 24, 3 | (1 << 8) | (100 << 16), p | (1n << 23n) | (1n << 24n)),
  ];
  assert.deepEqual(replayAt(es, 100, 340, 240).scores, [230, 0]);
  assert.equal(replayAt(es, 100, 340, 0).board[24].kind, 0);
  assert.deepEqual(summarize(es, a).stats, {
    build: 2,
    attack: 0,
    repair: 0,
    restored: 0,
    support: 0,
  });
  assert.equal(unpack(0, 24).objective, true);
});
