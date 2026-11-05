import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    // Same-origin in development, like production where Rust serves the built page.
    proxy: Object.fromEntries(
      ["/api", "/events", "/stream", "/media"].map((path) => [path, { target: "http://127.0.0.1:8080" }]),
    ),
  },
});
