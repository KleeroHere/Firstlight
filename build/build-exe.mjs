#!/usr/bin/env node
// Builds Firstlight.exe: a single Windows executable that runs the server
// (ui/server/server.mjs) and serves the built interface (ui/dist), with no
// Node.js install required to run it. Node itself still has to build it.
//
//   node build/build-exe.mjs            # build/dist/Firstlight/Firstlight.exe
//   build\build-exe.cmd                 # same, for double-clicking
//
// How: Node's own single-executable-application (SEA) support. server.mjs
// has no dependency beyond Node's built-ins, so it only needs converting from
// ESM to a single CommonJS file (esbuild does that — SEA's entry point must
// be CJS) and injecting into a copy of the Node binary that made the SEA
// blob (postject). @yao-pkg/pkg was the other option; it fetches a prebuilt
// Node per target and needs no ESM step, but it's a much heavier download for
// no benefit here since there is nothing beyond built-ins to bundle.
//
// What ships beside the exe: engine/ (the pipeline scripts — still run by a
// system Node/Python when the interface starts a job) and ui/dist/ (the
// built interface). The exe reads them next to itself, or from --workspace.
// The example workspace (workspace/) ships too, so the app has something to
// show the moment it opens.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "build", "out");
const PKG_DIR = join(ROOT, "build", "dist", "Firstlight");
const EXE_NAME = "Firstlight.exe";

const log = (msg) => console.log(`[build-exe] ${msg}`);
// A shell is only needed on Windows to resolve npm/npx/*.cmd shims — and a
// shell is exactly what mishandles a path with spaces (`C:\Program Files\...
// \node.exe`), so it is opt-in per call rather than on by default.
const run = (cmd, args, { shell = false } = {}) => {
  log(`${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell });
};

// --- 1. the interface -----------------------------------------------------

if (!existsSync(join(ROOT, "ui", "node_modules"))) {
  log("ui/node_modules is missing — installing once...");
  run("npm", ["--prefix", "ui", "install", "--no-audit", "--no-fund"], { shell: process.platform === "win32" });
}
log("building the interface (tsc && vite build)...");
run("npm", ["--prefix", "ui", "run", "build"], { shell: process.platform === "win32" });
if (!existsSync(join(ROOT, "ui", "dist", "index.html"))) {
  throw new Error("ui/dist/index.html is missing after the build — see the output above.");
}

// --- 2. server.mjs, ESM -> a single CJS file -------------------------------
// SEA's entry point has to be CommonJS. server.mjs imports nothing but
// Node's own modules, so bundling is really just the ESM-to-CJS rewrite;
// esbuild also inlines the one runtime branch (import.meta.url) that has no
// CJS equivalent, which is fine since that branch never runs inside the exe
// (resolveRoot() takes the isSea() branch instead — see server.mjs).
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const serverCjs = join(OUT, "server.cjs");
log("bundling ui/server/server.mjs to CommonJS...");
run(process.platform === "win32" ? "ui\\node_modules\\.bin\\esbuild.cmd" : "ui/node_modules/.bin/esbuild", [
  "ui/server/server.mjs",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node20",
  `--outfile=${serverCjs}`,
], { shell: process.platform === "win32" });

// --- 3. the SEA blob --------------------------------------------------------
const seaConfigPath = join(OUT, "sea-config.json");
const blobPath = join(OUT, "sea-prep.blob");
writeFileSync(
  seaConfigPath,
  JSON.stringify({ main: serverCjs, output: blobPath, disableExperimentalSEAWarning: true }, null, 2),
);
log("writing the SEA preparation blob...");
run(process.execPath, ["--experimental-sea-config", seaConfigPath]);
if (!existsSync(blobPath)) throw new Error("sea-prep.blob was not produced.");

// --- 4. copy the Node binary and inject the blob ---------------------------
const exePath = join(OUT, EXE_NAME);
log(`copying the Node binary (${process.execPath}) as the base for the .exe...`);
copyFileSync(process.execPath, exePath);

// The sentinel postject looks for is a fuse baked into the Node binary at
// build time; its value has changed shape across Node versions (the official
// docs' example string is stale as of Node 24), so it is read out of the
// binary itself rather than hard-coded.
const fuse = findFuse(exePath);
log(`removing the current code signature and injecting the blob (fuse ${fuse})...`);
run("npx", [
  "--yes",
  "postject",
  exePath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  fuse,
  ...(process.platform === "win32" ? ["--overwrite"] : []),
], { shell: process.platform === "win32" });

function findFuse(binPath) {
  const buf = readFileSync(binPath);
  const marker = Buffer.from("NODE_SEA_FUSE_");
  const idx = buf.indexOf(marker);
  if (idx === -1) throw new Error("Could not find the NODE_SEA_FUSE sentinel in this Node binary — Node ≥ 20 is required.");
  const tail = buf.subarray(idx, idx + 64).toString("latin1");
  const m = /^NODE_SEA_FUSE_[0-9a-f]+/.exec(tail);
  if (!m) throw new Error(`Found a NODE_SEA_FUSE marker but could not parse it: ${tail}`);
  return m[0];
}

// --- 5. assemble the portable folder ---------------------------------------
log(`assembling the portable folder at ${PKG_DIR}...`);
rmSync(PKG_DIR, { recursive: true, force: true });
mkdirSync(PKG_DIR, { recursive: true });
copyFileSync(exePath, join(PKG_DIR, EXE_NAME));
cpSync(join(ROOT, "engine"), join(PKG_DIR, "engine"), { recursive: true, filter: (src) => !src.includes("__pycache__") });
cpSync(join(ROOT, "ui", "dist"), join(PKG_DIR, "ui", "dist"), { recursive: true });
cpSync(join(ROOT, "workspace"), join(PKG_DIR, "workspace"), { recursive: true, filter: (src) => !src.includes("__pycache__") });

log("done.");
log(`  ${join(PKG_DIR, EXE_NAME)}`);
log("Run it, or see README.md → Download / Run.");
