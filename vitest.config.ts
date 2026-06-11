import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  // hot:false stops the plugin from injecting /@solid-refresh imports,
  // which Node cannot load under vitest's serve-mode transform.
  plugins: [solid({ hot: false })],
  // Resolve solid-js to its browser build instead of the SSR build.
  resolve: { conditions: ["development", "browser"] },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["**/node_modules/**", "**/archive/**", "**/dist/**"],
  },
});
