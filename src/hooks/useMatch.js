import { useCallback, useEffect, useRef, useState } from "react";
import { snapshot, loadEvents, verifyGame } from "../chain/client.js";
import { coalescedRefresh, retryRead } from "../chain/sync.js";
import { explainError } from "../chain/errors.js";

export function useMatch(context, address, fromBlock) {
  const [state, setState] = useState(null),
    [events, setEvents] = useState([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [historyReady, setHistoryReady] = useState(false),
    [historyError, setHistoryError] = useState("");
  const refreshRef = useRef(null);
  useEffect(() => {
    setState(null);
    setEvents([]);
    setError("");
    setHistoryReady(false);
    setHistoryError("");
    if (!context || !address) {
      setLoading(false);
      refreshRef.current = null;
      return;
    }
    let live = true,
      inflight = null,
      verified = false,
      anchor = null,
      cursor = BigInt(fromBlock || 0);
    setLoading(true);
    const pull = async () => {
      if (!live) return;
      try {
        if (!verified) {
          await retryRead(() => verifyGame(context, address));
          verified = true;
        }
        const next = await retryRead(() => snapshot(context, address));
        if (!live) return;
        if (anchor) {
          const changed =
            next.blockNumber < anchor.number ||
            (next.blockNumber === anchor.number
              ? next.blockHash !== anchor.hash
              : next.blockNumber === anchor.number + 1n
                ? next.parentHash !== anchor.hash
                : (
                    await retryRead(() =>
                      context.publicClient.getBlock({
                        blockNumber: anchor.number,
                      }),
                    )
                  ).hash !== anchor.hash);
          if (!live) return;
          if (changed) {
            cursor = BigInt(fromBlock || 0);
            setEvents([]);
            setHistoryReady(false);
          }
        }
        anchor = { number: next.blockNumber, hash: next.blockHash };
        setState(next);
        setError("");
        setLoading(false);
        const begin = cursor > 6n ? cursor - 6n : BigInt(fromBlock || 0);
        try {
          const logs = await loadEvents(
            context,
            address,
            begin,
            next.blockNumber,
          );
          if (!live) return;
          setEvents((old) => [
            ...old.filter((e) => e.blockNumber < begin),
            ...logs,
          ]);
          cursor = next.blockNumber + 1n;
          setHistoryReady(true);
          setHistoryError("");
        } catch (err) {
          if (live) {
            setHistoryReady(false);
            setHistoryError(explainError(err));
          }
        }
      } catch (err) {
        if (live) {
          setError(explainError(err));
          setLoading(false);
        }
      }
    };
    const refresh = coalescedRefresh(async () => {
      if (!live) return;
      inflight = pull();
      try {
        await inflight;
      } finally {
        inflight = null;
      }
    });
    refreshRef.current = refresh;
    void refresh();
    const timer = setInterval(() => {
      if (!inflight) void refresh();
    }, 1500);
    return () => {
      live = false;
      clearInterval(timer);
      refreshRef.current = null;
    };
  }, [context, address, fromBlock]);
  return {
    state,
    events,
    error,
    loading,
    historyReady,
    historyError,
    refresh: useCallback(() => refreshRef.current?.(), []),
  };
}
