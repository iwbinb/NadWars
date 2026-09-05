import { createPublicClient, http, decodeEventLog } from "viem";
import { writeFile } from "node:fs/promises";
import { artifacts, detectMode } from "../src/chain/verify.js";
import { replayMatchAt, summarize } from "../src/game/replay.js";
const [rpc, address, from, out] = process.argv.slice(2);
if (!rpc || !address || !from || !out)
  throw new Error(
    "Usage: node scripts/verify-match.mjs RPC ADDRESS FROM_BLOCK OUTPUT",
  );
const client = createPublicClient({ transport: http(rpc) }),
  mode = detectMode(await client.getCode({ address }));
if (!mode) throw new Error("Contract runtime mismatch");
const abi = artifacts[mode].abi,
  block = await client.getBlock();
const read = (functionName, args = []) =>
  client.readContract({
    address,
    abi,
    functionName,
    args,
    blockNumber: block.number,
  });
let startAt, endAt, players, scores, zones, matchId, rulesHash;
if (mode === "standard") {
  const v = await read("matchView");
  if (Number(v.phase) !== 4) throw new Error("Match has not been finalized");
  ({ startAt, endAt, matchId, rulesHash } = v);
  players = v.seats;
  scores = [Number(v.score1), Number(v.score2)];
  zones = v.zones.map((z) => ({
    rawBoard: z.cells.map(Number),
    power1: z.power1,
    power2: z.power2,
    scores: [Number(z.score1), Number(z.score2)],
  }));
} else {
  if (!(await read("finished")))
    throw new Error("Match has not been finalized");
  [startAt, endAt, matchId, rulesHash] = await Promise.all([
    read("startAt"),
    read("endAt"),
    read("matchId"),
    read("RULES_HASH"),
  ]);
  players = await Promise.all([read("seats", [0n]), read("seats", [1n])]);
  scores = (await read("scores")).map(Number);
  zones = [
    {
      rawBoard: (await read("board")).map(Number),
      power1: await read("power1"),
      power2: await read("power2"),
      scores,
    },
  ];
}
const logs = [];
for (let cursor = BigInt(from); cursor <= block.number; cursor += 500n)
  logs.push(
    ...(await client.getLogs({
      address,
      fromBlock: cursor,
      toBlock: cursor + 499n > block.number ? block.number : cursor + 499n,
    })),
  );
const events = logs
  .flatMap((log) => {
    try {
      const e = decodeEventLog({ abi, data: log.data, topics: log.topics });
      return [
        "ActionResolved",
        "SupportStarted",
        "MatchStarted",
        "MatchSettled",
      ].includes(e.eventName)
        ? [{ ...log, ...e }]
        : [];
    } catch {
      return [];
    }
  })
  .sort(
    (a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex,
  );
if (
  !events.some((e) => e.eventName === "MatchStarted") ||
  !events.some((e) => e.eventName === "MatchSettled")
)
  throw new Error("Incomplete event history");
const replay = replayMatchAt(
  events,
  Number(startAt),
  Number(endAt),
  Number(endAt - startAt),
  zones.length,
);
for (let z = 0; z < zones.length; z++) {
  const encoded = replay.zones[z].board.map(
    (c) => c.kind | (c.team << 8) | (c.hp << 16),
  );
  if (
    JSON.stringify(encoded) !== JSON.stringify(zones[z].rawBoard) ||
    replay.zones[z].power1 !== zones[z].power1 ||
    replay.zones[z].power2 !== zones[z].power2
  )
    throw new Error(`Zone ${z} replay mismatch`);
  if (
    JSON.stringify(replay.zones[z].scores) !== JSON.stringify(zones[z].scores)
  )
    throw new Error(`Zone ${z} score mismatch`);
}
if (JSON.stringify(replay.scores) !== JSON.stringify(scores))
  throw new Error("Aggregate score mismatch");
const actions = events.filter(
  (e) => e.eventName === "ActionResolved" || e.eventName === "SupportStarted",
);
const receipts = [];
for (const e of events)
  receipts.push(
    await client.getTransactionReceipt({ hash: e.transactionHash }),
  );
if (receipts.some((r) => r.status !== "success"))
  throw new Error("Failed event transaction");
const report = {
  verifiedAt: new Date().toISOString(),
  chainId: await client.getChainId(),
  mode,
  contract: address,
  matchId,
  rulesHash,
  blockNumber: block.number,
  startAt,
  endAt,
  finished: true,
  players,
  scores,
  zones,
  replayScores: replay.scores,
  boardMatches: true,
  scoresMatch: true,
  actionCount: actions.length,
  uniquePlayers: new Set(actions.map((e) => e.args.player.toLowerCase())).size,
  actionTypes: [
    ...new Set(
      actions.map((e) =>
        e.eventName === "SupportStarted" ? 3 : Number(e.args.action),
      ),
    ),
  ],
  zoneActionCounts: zones.map(
    (_, z) =>
      actions.filter((e) => Number(e.args.zone ?? e.args.toZone ?? 0) === z)
        .length,
  ),
  contributions: players.map((p) => summarize(events, p).stats),
  events,
  receipts: receipts.map((r) => ({
    hash: r.transactionHash,
    status: r.status,
    block: r.blockNumber,
    gasUsed: r.gasUsed,
  })),
};
await writeFile(
  out,
  JSON.stringify(
    report,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    scores,
    actions: actions.length,
    players: report.uniquePlayers,
    mode,
    zoneActions: report.zoneActionCounts,
    boardMatches: true,
    scoresMatch: true,
    actionTypes: report.actionTypes,
  }),
);
