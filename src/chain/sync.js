// Retry reads only. A failed read must never resubmit a transaction.
export function isTransientReadError(error) {
  for (let e = error; e; e = e.cause) {
    if (e.data?.errorName) return false;
    if ([-32011, 429, 502, 503, 504].includes(e.code ?? e.status)) return true;
    if (
      /requests limited|rate limit|too many requests|Required data unavailable|header not found|block not found|HTTP request failed|fetch failed|timeout/i.test(
        e.shortMessage || e.message || "",
      )
    )
      return true;
  }
  return false;
}
export async function retryRead(
  read,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= 2 || !isTransientReadError(error)) throw error;
      await wait(600 * (attempt + 1));
    }
  }
}
// All invalidation hints arriving during a read share one trailing refresh.
export function coalescedRefresh(pull) {
  let active = null,
    queued = false;
  return () => {
    if (active) {
      queued = true;
      return active;
    }
    active = (async () => {
      try {
        do {
          queued = false;
          await pull();
        } while (queued);
      } finally {
        active = null;
      }
    })();
    return active;
  };
}
