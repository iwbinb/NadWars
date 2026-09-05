const messages = {
  WrongPhase: "当前阶段不能执行这个操作",
  InvalidTeam: "阵营无效",
  SeatOccupied: "这个阵营已经有人加入",
  AlreadyJoined: "你已经加入了本局",
  NotPlayer: "请先加入对局",
  NotReady: "需要双方重新准备",
  StaleRoster: "玩家名单已变化，请重新准备",
  InvalidRules: "规则版本不匹配",
  Unauthorized: "没有执行权限",
  InvalidTile: "格子超出地图",
  InvalidKind: "设施类型与格子不匹配",
  InvalidTarget: "目标已变化，请重新选择",
  NotConnected: "目标没有连接到己方供电网络",
  CoolingDown: "操作仍在冷却",
  InsufficientEnergy: "行动能源不足",
  WrongNonce: "该操作已经处理，正在同步最新状态",
  InvalidSession: "本局授权已过期或被撤销，请重新授权",
  ExpiredAction: "操作已过期，请重新确认",
  InvalidSignature: "签名校验未通过",
};
export function explainError(error) {
  let current = error;
  while (current) {
    if (current.data?.errorName && messages[current.data.errorName])
      return messages[current.data.errorName];
    if (current.code === 4001 || current.name === "UserRejectedRequestError")
      return "你已取消钱包操作";
    current = current.cause;
  }
  const raw = error?.shortMessage || error?.message || String(error);
  for (const [key, value] of Object.entries(messages))
    if (raw.includes(key)) return value;
  if (/insufficient funds/i.test(raw))
    return "钱包中的测试 MON 不足以支付手续费";
  if (/chain.*mismatch|wrong.*chain/i.test(raw))
    return "请切换到当前对局的网络";
  if (/Required data unavailable/i.test(raw))
    return "节点暂时无法读取执行数据，请同步后重试；尚未确认成功。";
  if (/RPC Request failed|HTTP request failed|fetch failed/i.test(raw))
    return "链上数据读取暂时失败，正在自动重试。若交易已确认，请勿重复提交。";
  return raw.length > 180 ? `${raw.slice(0, 180)}…` : raw;
}
