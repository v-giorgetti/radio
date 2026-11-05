import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Served by the Rust server under /host/ in production.
  base: "/host/",
  plugins: [react()],
  server: {
    port: 5174,
    // Same origin as production, where the Rust server serves this app under /host/.
    proxy: Object.fromEntries(["/api", "/media"].map((path) => [path, { target: "http://127.0.0.1:8080" }])),
  },
});
