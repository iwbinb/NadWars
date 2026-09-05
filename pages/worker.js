// Pages owns the public domain. Existing room/state/relay services remain in the backend Worker.
export default {
  fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/api/")) {
      // Preserve the original URL, Origin and WebSocket upgrade for same-origin game APIs.
      return env.NADWARS_API.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
