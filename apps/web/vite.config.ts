import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// CONSOLE_PROXY points the dev server at another console (e.g. an isolated test stack).
const consoleTarget = process.env.CONSOLE_PROXY ?? "http://localhost:8401";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 8402),
    proxy: {
      "/api": {
        target: consoleTarget,
        changeOrigin: true,
      },
      "/auth": {
        target: consoleTarget,
        changeOrigin: true,
      },
    },
  },
});
