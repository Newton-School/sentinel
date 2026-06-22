import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is served by the dashboard API at a single origin in production. In
// dev, proxy /api to the locally-running API (npm run dashboard, port 8940).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8940" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
