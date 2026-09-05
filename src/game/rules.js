export const KIND = ["空地", "发电站", "中继站", "能源目标", "炮塔", "护盾站"];
export const KIND_ASSET = [
  null,
  "reactor",
  "relay",
  "objective",
  "turret",
  "shield",
];
export const HP = [0, 1, 100, 100, 120, 120];
export const COST = [0, 0, 15, 20, 35, 30];
export const OBJECTIVES = [10, 24, 38];
export const ROOTS = [21, 27];
export const TEAM = ["中立", "紫电队", "琥珀队"];
export const ZONES = ["北区", "东区", "西区", "南区"];
export const adjacentZones = (a, b) =>
  a >= 0 && a < 4 && b >= 0 && b < 4 && ((a ^ b) === 1 || (a ^ b) === 2);
export const effectiveZone = (player, now) =>
  player?.arriveAt && now >= player.arriveAt
    ? player.destination
    : (player?.zone ?? 0);
export function supportHint({
  player,
  destination,
  phase,
  now,
  energy,
  cooldown,
}) {
  if (!player) return "加入阵营后才能支援";
  if (phase !== 2) return "等待对局开始";
  if (player.arriveAt > now)
    return `支援途中 · ${Math.ceil(player.arriveAt - now)} 秒后抵达`;
  if (cooldown > 0) return `操作冷却 ${Math.ceil(cooldown)} 秒`;
  if (!adjacentZones(effectiveZone(player, now), destination))
    return "只能支援直接相邻的战区";
  if (energy < 25) return `还需要 ${Math.ceil(25 - energy)} 能源`;
  return "";
}
export const ZERO = "0x0000000000000000000000000000000000000000";

export function neighbors(tile) {
  const q = tile % 7,
    r = Math.floor(tile / 7);
  return [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, -1],
    [-1, 1],
  ]
    .map(([dq, dr]) => [q + dq, r + dr])
    .filter(([x, y]) => x >= 0 && x < 7 && y >= 0 && y < 7)
    .map(([x, y]) => y * 7 + x);
}
export function unpack(raw, index, power1 = 0n, power2 = 0n) {
  const n = Number(raw),
    kind = n & 255,
    team = (n >> 8) & 255,
    hp = n >>> 16;
  const mask = team === 1 ? power1 : team === 2 ? power2 : 0n;
  return {
    index,
    kind,
    team,
    hp,
    maxHp: HP[kind],
    objective: OBJECTIVES.includes(index),
    powered: Boolean((BigInt(mask) >> BigInt(index)) & 1n),
  };
}
export function initialBoard() {
  return Array.from({ length: 49 }, (_, i) =>
    unpack(
      i === 21
        ? 65793
        : i === 27
          ? 66049
          : i === 22
            ? 6553858
            : i === 26
              ? 6554114
              : 0,
      i,
      (1n << 21n) | (1n << 22n),
      (1n << 26n) | (1n << 27n),
    ),
  );
}
export function maskCount(mask) {
  return OBJECTIVES.filter((i) => Boolean((BigInt(mask) >> BigInt(i)) & 1n))
    .length;
}
export function shortAddress(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "等待加入";
}
export function clock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
export function tileLabel(i) {
  return `${String.fromCharCode(65 + (i % 7))}${Math.floor(i / 7) + 1}`;
}

// Client hints only. The contract remains the validator for every submitted action.
export function actionHint({
  board,
  selected,
  tool,
  buildKind,
  team,
  energy,
  cooldown,
  phase,
  travelRemaining = 0,
  wrongZone = false,
}) {
  if (!team) return "加入一个阵营后才能操作";
  if (phase !== 2) return phase >= 3 ? "对局已结束" : "等待对局开始";
  if (travelRemaining > 0)
    return `支援途中 · ${Math.ceil(travelRemaining)} 秒后抵达`;
  if (wrongZone) return "你不在这个战区，可先发起支援";
  if (cooldown > 0) return `操作冷却 ${Math.ceil(cooldown)} 秒`;
  if (selected == null) return "先选择地图上的格子";
  const cell = board[selected];
  const adjacent = neighbors(selected).some(
    (i) => board[i].team === team && board[i].powered,
  );
  if (tool === "build") {
    if (cell.kind) return "这里已有设施";
    if (!adjacent) return "需要邻接己方通电设施";
    const kind = cell.objective ? 3 : buildKind;
    if (energy < COST[kind])
      return `还需要 ${Math.ceil(COST[kind] - energy)} 能源`;
  } else if (tool === "attack") {
    if (!cell.kind || cell.kind === 1 || cell.team === team)
      return "请选择敌方可攻击设施";
    if (!adjacent) return "目标需邻接己方通电设施";
    if (energy < 18) return `还需要 ${Math.ceil(18 - energy)} 能源`;
  } else if (tool === "repair") {
    if (!cell.kind || cell.kind === 1 || cell.team !== team)
      return "请选择己方受损设施";
    if (cell.hp === cell.maxHp) return "设施耐久已满";
    if (!cell.powered && !adjacent) return "先恢复通往这里的供电线路";
    if (energy < 12) return `还需要 ${Math.ceil(12 - energy)} 能源`;
  }
  return "";
}
