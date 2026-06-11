import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const host = process.env.TAURI_DEV_HOST;
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      // remark/unified chain uses CJS packages; Vite ESM default import fails without shims
      debug: path.resolve(rootDir, "src/shims/debug.ts"),
      extend: path.resolve(rootDir, "src/shims/extend.ts"),
    },
  },
  optimizeDeps: {
    include: ["remark-gfm", "solid-markdown", "unified", "remark-parse", "remark-rehype"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Tauri WebView on Windows resolves localhost to 127.0.0.1; ::1-only breaks loading
    host: host || "127.0.0.1",
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows"
        ? "chrome105"
        : "safari13",
    // vite 8 (rolldown) no longer bundles esbuild; oxc is its native minifier
    minify: !process.env.TAURI_ENV_DEBUG ? "oxc" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
