import { useEffect, useState } from "react";

// The room socket is only an invalidation hint. Game state is always read from the contract.
export function useRoomConnection(context, address, refresh) {
  const [status, setStatus] = useState("polling");
  useEffect(() => {
    if (!context?.config.roomSocket || !address) {
      setStatus("polling");
      return;
    }
    let live = true,
      socket,
      retry,
      heartbeat,
      attempt = 0;
    const connect = () => {
      if (!live) return;
      setStatus("connecting");
      const url = new URL(
        `/api/rooms/${address.toLowerCase()}/socket`,
        location.origin,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.onopen = () => {
        if (!live) return;
        attempt = 0;
        setStatus("live");
        void refresh();
        heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send("ping");
        }, 25000);
      };
      socket.onmessage = (event) => {
        if (event.data === "pong") return;
        try {
          if (JSON.parse(event.data).type === "changed") void refresh();
        } catch {}
      };
      socket.onclose = () => {
        clearInterval(heartbeat);
        if (!live) return;
        setStatus("polling");
        retry = setTimeout(connect, Math.min(15000, 1000 * 2 ** attempt++));
      };
      socket.onerror = () => socket.close();
    };
    const online = () => {
      void refresh();
      if (socket?.readyState === WebSocket.CLOSED) {
        clearTimeout(retry);
        connect();
      }
    };
    connect();
    window.addEventListener("online", online);
    return () => {
      live = false;
      clearTimeout(retry);
      clearInterval(heartbeat);
      socket?.close();
      window.removeEventListener("online", online);
    };
  }, [context, address, refresh]);
  return status;
}
