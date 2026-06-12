import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @tauri-apps/cli sets these env vars when it runs the dev/build commands.
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Prevent Vite from clobbering Rust compiler errors in the terminal.
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // Tauri's Rust sources change constantly during dev; don't let Vite watch them.
      ignored: ["**/src-tauri/**"],
    },
  },

  // Only env vars prefixed with these are exposed to the frontend.
  envPrefix: ["VITE_", "TAURI_ENV_*"],

  build: {
    // Tauri uses Chromium on Windows and WebKit on Linux.
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },

  // Monaco's language workers are bundled as ES module workers.
  worker: {
    format: "es",
  },
}));
