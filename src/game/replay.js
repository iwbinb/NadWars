import { initialBoard, unpack, maskCount, ROOTS } from "./rules.js";
export function replayAt(events, startAt, endAt, second) {
  let board = initialBoard(),
    power1 = (1n << 21n) | (1n << 22n),
    power2 = (1n << 26n) | (1n << 27n),
    cursor = startAt,
    scores = [0, 0];
  const target = Math.min(endAt, startAt + second);
  for (const e of events) {
    if (e.eventName !== "ActionResolved") continue;
    const a = e.args,
      t = Number(a.timestamp);
    if (t > target) break;
    const dt = Math.max(0, t - cursor);
    scores[0] += dt * maskCount(power1);
    scores[1] += dt * maskCount(power2);
    cursor = t;
    const raw = board.map((c) => c.kind | (c.team << 8) | (c.hp << 16));
    raw[Number(a.tile)] = Number(a.cellAfter);
    power1 = BigInt(a.power1);
    power2 = BigInt(a.power2);
    board = raw.map((v, i) => unpack(v, i, power1, power2));
  }
  scores[0] += Math.max(0, target - cursor) * maskCount(power1);
  scores[1] += Math.max(0, target - cursor) * maskCount(power2);
  return { board, scores, power1, power2 };
}
export function summarize(events, viewer) {
  const boards = Array.from({ length: 4 }, initialBoard);
  const moments = [],
    stats = { build: 0, attack: 0, repair: 0, restored: 0, support: 0 };
  for (const e of events) {
    if (e.eventName === "SupportStarted") {
      if (!viewer || e.args.player.toLowerCase() === viewer.toLowerCase())
        stats.support++;
      moments.push({
        event: e,
        support: true,
        zone: Number(e.args.toZone),
        tile: 0,
        restored: 0,
        lost: 0,
      });
      continue;
    }
    if (e.eventName !== "ActionResolved") continue;
    const zone = Number(e.args.zone ?? 0),
      board = boards[zone];
    const a = e.args,
      tile = Number(a.tile),
      raw = board.map((c) => c.kind | (c.team << 8) | (c.hp << 16));
    raw[tile] = Number(a.cellAfter);
    const next = raw.map((v, i) => unpack(v, i, a.power1, a.power2));
    const restored = next.filter(
      (c, i) =>
        c.powered &&
        !board[i].powered &&
        board[i].kind &&
        c.team === board[i].team &&
        !ROOTS.includes(i),
    ).length;
    const lost = next.filter(
      (c, i) =>
        !c.powered &&
        board[i].powered &&
        c.kind &&
        c.team === board[i].team &&
        !ROOTS.includes(i),
    ).length;
    if (!viewer || a.player.toLowerCase() === viewer.toLowerCase()) {
      stats[["build", "attack", "repair"][Number(a.action)]]++;
      stats.restored += restored;
    }
    if (restored || lost)
      moments.push({ event: e, restored, lost, tile, zone });
    boards[zone] = next;
  }
  return { stats, moments };
}

export function replayMatchAt(events, startAt, endAt, second, zoneCount = 1) {
  const zones = Array.from({ length: zoneCount }, (_, zone) => ({
    ...replayAt(
      events.filter(
        (e) =>
          e.eventName !== "ActionResolved" || Number(e.args.zone ?? 0) === zone,
      ),
      startAt,
      endAt,
      second,
    ),
    index: zone,
  }));
  return {
    zones,
    scores: zones.reduce(
      (total, z) => [total[0] + z.scores[0], total[1] + z.scores[1]],
      [0, 0],
    ),
  };
}

export function replayPlayersAt(
  events,
  players,
  startAt,
  second,
  zoneCount = 4,
) {
  const target = startAt + second;
  const result = players.map((p, i) =>
    p
      ? { ...p, zone: i % zoneCount, destination: i % zoneCount, arriveAt: 0 }
      : null,
  );
  for (const e of events) {
    if (e.eventName !== "SupportStarted" || Number(e.args.timestamp) > target)
      continue;
    const p = result.find(
      (p) => p?.address.toLowerCase() === e.args.player.toLowerCase(),
    );
    if (p) {
      p.zone = Number(e.args.fromZone);
      p.destination = Number(e.args.toZone);
      p.arriveAt = Number(e.args.arriveAt);
    }
  }
  return result.map((p) =>
    p && p.arriveAt && p.arriveAt <= target
      ? { ...p, zone: p.destination, arriveAt: 0 }
      : p,
  );
}

// A fetched range alone is not proof of a complete replay.
export function matchesReplay(events, state) {
  if (!state || state.phase !== 4) return false;
  if (
    !events.some(
      (e) =>
        e.eventName === "MatchStarted" &&
        Number(e.args.startAt) === state.startAt,
    )
  )
    return false;
  if (
    !events.some(
      (e) =>
        e.eventName === "MatchSettled" && Number(e.args.endAt) === state.endAt,
    )
  )
    return false;
  const match = replayMatchAt(
    events,
    state.startAt,
    state.endAt,
    state.endAt - state.startAt,
    state.zoneCount || 1,
  );
  if (state.mode === "standard")
    return (
      match.scores.every((v, i) => v === state.scores[i]) &&
      match.zones.every(
        (final, z) =>
          final.board.every(
            (c, i) =>
              (c.kind | (c.team << 8) | (c.hp << 16)) ===
              state.zones[z].rawBoard[i],
          ) &&
          final.power1 === state.zones[z].power1 &&
          final.power2 === state.zones[z].power2,
      )
    );
  const final = match.zones[0];
  return (
    final.scores.every((v, i) => v === state.scores[i]) &&
    final.board.every(
      (c, i) => (c.kind | (c.team << 8) | (c.hp << 16)) === state.rawBoard[i],
    ) &&
    final.power1 === state.power1 &&
    final.power2 === state.power2
  );
}
