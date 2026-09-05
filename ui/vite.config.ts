import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI talks to server/server.mjs, which lists rolls, reads their state files
// and runs the engine scripts. In development Vite proxies /api to it.
//
// The GitHub Pages build (.github/workflows/pages.yml) is the one build with
// no server behind it at all: it sets BASE_PATH to "/Firstlight/" (the repo
// name, since project pages are served from a subpath) and VITE_DEMO=1, which
// switches the interface to reading the static snapshots in ui/public/demo/
// instead — see DEMO in src/api.ts. Every other build (npm run build for the
// .exe, npm run dev) is unaffected: base stays "/".
export default defineConfig({
  base: process.env.BASE_PATH || "/",
  plugins: [react()],
  server: { port: 1421, proxy: { "/api": "http://localhost:7331", "/files": "http://localhost:7331" } },
});
