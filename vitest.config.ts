import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep vitest's default test discovery (**/*.{test,spec}.?(c|m)[jt]s?(x))
    // so every existing tests/**/*.test.ts is still picked up. We only add a
    // global setup file here.
    setupFiles: ["./tests/setup.ts"],
  },
});
