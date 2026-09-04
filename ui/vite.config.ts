import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI talks to server/server.mjs, which lists rolls, reads their state files
// and runs the engine scripts. In development Vite proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: { port: 1421, proxy: { "/api": "http://localhost:7331", "/files": "http://localhost:7331" } },
});
