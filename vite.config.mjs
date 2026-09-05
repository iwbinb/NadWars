import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localApi } from "./dev/local-api.mjs";

export default defineConfig({
  build: {
    outDir: "dist/client",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("node_modules") &&
            /\/(viem|ox|abitype|@noble|@scure)\//.test(id)
          )
            return "wallet";
          if (
            id.includes("node_modules") &&
            /\/(react|react-dom|scheduler)\//.test(id)
          )
            return "react";
        },
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), localApi()],
});
