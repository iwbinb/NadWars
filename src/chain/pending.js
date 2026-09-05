// Resolve a lost relay response using the player's nonce and the successful chain event.
export function resolvePendingIntent(intent, events, nonce, timestamp) {
  const event = events.find(
    (e) =>
      ["ActionResolved", "SupportStarted"].includes(e.eventName) &&
      e.args.player.toLowerCase() === intent.player.toLowerCase() &&
      BigInt(e.args.nonce) === BigInt(intent.nonce),
  );
  if (event) {
    const action =
      event.eventName === "SupportStarted" ? 3 : Number(event.args.action);
    const matches =
      action === intent.action &&
      Number(event.args.zone ?? event.args.toZone ?? 0) === intent.zone &&
      (action === 3 || Number(event.args.tile) === intent.tile) &&
      (action !== 0 || (Number(event.args.cellAfter) & 255) === intent.kind);
    return {
      status: matches ? "confirmed" : "failed",
      hash: event.transactionHash,
      text: matches
        ? "已核实：操作已在链上执行"
        : "该序号已用于另一项操作，请核对战场",
    };
  }
  if (
    BigInt(nonce) === BigInt(intent.nonce) &&
    timestamp > Number(intent.deadline)
  )
    return { status: "failed", text: "已核实：签名过期且未执行，可以重新操作" };
  return null;
}
