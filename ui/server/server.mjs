// Firstlight — the local server behind the interface.
//
// It does three things and nothing else: lists the rolls and their state by
// looking at the workspace on disk, serves the files the interface shows
// (frames, takes, finished episodes), and runs engine scripts as jobs whose
// output streams to the browser. It keeps no database: the workspace IS the
// state, exactly as it is for the command line. Close the server and nothing
// is lost; open it again and it reads the same folders.
//
//   node ui/server/server.mjs              # API on :7331, use with `vite`
//   node ui/server/server.mjs --serve dist # also serve the built interface
//
// No dependencies beyond Node itself, on purpose.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, renameSync, createReadStream } from "node:fs";
import { join, resolve, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CFG = JSON.parse(readFileSync(join(ROOT, "engine", "pipeline.config.json"), "utf8"));
const P = Object.fromEntries(Object.entries(CFG.paths).map(([k, v]) => [k, join(ROOT, v)]));
const PORT = Number(process.env.PORT || 7331);
const serveDist = process.argv.includes("--serve") ? join(ROOT, "ui", process.argv[process.argv.indexOf("--serve") + 1] || "dist") : null;

// --- reading the workspace ----------------------------------------------------

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);
const list = (dir, pred = () => true) => (existsSync(dir) ? readdirSync(dir).filter(pred) : []);

/** The stage a roll has reached, worked out from which files exist. */
function stageOf(roll) {
  if (roll.verify?.verdict === "pass") return "accepted";
  if (roll.output) return "assembled";
  if (roll.scenes.some((s) => s.takes.length)) return "shot";
  if (roll.scenes.some((s) => s.frames.length)) return "keyed";
  return "planned";
}

function readRoll(id) {
  const sc = readJson(join(P.compiled, `${id}.json`));
  if (!sc) return null;
  const takesDir = join(P.takes, id);
  const files = list(takesDir);
  const rejected = list(join(takesDir, "_rejected"));
  const scenes = (sc.scenes ?? []).map((s) => ({
    id: s.id,
    kind: s.kind ?? "scene",
    plate: s.plate ?? "",
    t: s.t ?? null,
    chars: s.chars ?? [],
    bg: s.bg ?? null,
    img: s.img ?? "",
    anim: s.anim ?? "",
    vo: s.vo ?? "",
    frames: files.filter((f) => f.startsWith(`${s.id}_sh`) && f.endsWith("_frame.png")).sort(),
    takes: files.filter((f) => f.startsWith(`${s.id}_take`) && /\.(mp4|png|jpg)$/i.test(f)).sort(),
    rejected: rejected.filter((f) => f.startsWith(`${s.id}_`)).length,
  }));
  // The finished episode is named by title; the build log beside it is the
  // reliable link back to the id.
  const outFiles = list(P.out, (f) => f.endsWith(".build-log.json"));
  let output = null;
  let buildLog = null;
  for (const f of outFiles) {
    const log = readJson(join(P.out, f));
    if (log?.id === id) {
      buildLog = log;
      const mp4 = f.replace(/\.build-log\.json$/, ".mp4");
      if (existsSync(join(P.out, mp4))) output = mp4;
      break;
    }
  }
  const verify = output ? readJson(join(P.out, output.replace(/\.mp4$/, ".verify.json"))) : null;
  const roll = {
    id,
    title: sc.title ?? id,
    durationTarget: sc.duration_target ?? null,
    scenes,
    output,
    buildLog: buildLog && { createdAt: buildLog.createdAt, totalDuration: buildLog.totalDuration, voMode: buildLog.voMode },
    verify: verify && { verdict: verify.verdict, counts: verify.counts, checkedAt: verify.checkedAt, checks: verify.checks },
    priemka: existsSync(join(takesDir, "priemka.html")),
    updatedAt: Math.max(mtime(takesDir), output ? mtime(join(P.out, output)) : 0),
  };
  roll.stage = stageOf(roll);
  return roll;
}

function readRolls() {
  return list(P.compiled, (f) => f.endsWith(".json"))
    .map((f) => readRoll(basename(f, ".json")))
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function readSpend() {
  return readJson(join(ROOT, "workspace", "spend.json"));
}

// --- jobs: running engine scripts ---------------------------------------------

// Only scripts from this list can be started from the browser, with arguments
// the interface composes. The server never runs a shell string.
const SCRIPTS = {
  keys: { cmd: "node", file: "engine/flf_keys.mjs" },
  sheet: { cmd: "node", file: "engine/keys_sheet.mjs" },
  synthetic: { cmd: "node", file: "engine/make_synthetic_takes.mjs" },
  assemble: { cmd: "node", file: "engine/assemble_video.mjs" },
  verify: { cmd: "node", file: "engine/verify_video.mjs" },
  clips: { cmd: "node", file: "engine/verify_clips.mjs" },
  sort: { cmd: "node", file: "engine/sort_downloads.mjs" },
  compile: { cmd: "python", file: "engine/build_prompts.py" },
};
const ARG_OK = /^[\w./-]+$/;

const jobs = new Map();
let jobSeq = 0;

function startJob(script, args) {
  const spec = SCRIPTS[script];
  if (!spec) throw new Error(`unknown script: ${script}`);
  for (const a of args) if (!ARG_OK.test(a)) throw new Error(`argument not allowed: ${a}`);
  const id = String(++jobSeq);
  const job = { id, script, args, startedAt: new Date().toISOString(), lines: [], done: false, code: null, listeners: new Set() };
  jobs.set(id, job);
  const child = spawn(spec.cmd, [join(ROOT, spec.file), ...args], {
    cwd: ROOT,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  const push = (line) => {
    job.lines.push(line);
    for (const res of job.listeners) res.write(`data: ${JSON.stringify(line)}\n\n`);
  };
  let buf = "";
  const onData = (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      push(buf.slice(0, i).replace(/\r$/, ""));
      buf = buf.slice(i + 1);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => {
    if (buf) push(buf);
    job.done = true;
    job.code = code;
    for (const res of job.listeners) {
      res.write(`event: done\ndata: ${JSON.stringify({ code })}\n\n`);
      res.end();
    }
    job.listeners.clear();
  });
  return job;
}

// --- frame decisions ----------------------------------------------------------

/** Rejecting a frame moves it to _rejected/, which is where the engine already keeps them. */
function rejectFrame(rollId, file) {
  if (!ARG_OK.test(rollId) || !ARG_OK.test(file) || file.includes("/")) throw new Error("bad name");
  const from = join(P.takes, rollId, file);
  if (!existsSync(from)) throw new Error("no such frame");
  const dir = join(P.takes, rollId, "_rejected");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  renameSync(from, join(dir, `${stamp}_${file}`));
}

// --- http ---------------------------------------------------------------------

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ttf": "font/ttf" };

function sendJson(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Files under the workspace only; a path that escapes it is refused. */
function sendFile(res, base, rel, req) {
  const abs = resolve(base, rel);
  if (!abs.startsWith(resolve(base)) || !existsSync(abs) || statSync(abs).isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  const size = statSync(abs).size;
  const type = MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
  // Video needs range requests or the player cannot seek.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && type.startsWith("video/")) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1, "accept-ranges": "bytes" });
    return createReadStream(abs, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
  createReadStream(abs).pipe(res);
}

async function readBody(req) {
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  try {
    if (path === "/api/rolls") return sendJson(res, 200, { rolls: readRolls(), spend: readSpend() });
    let m;
    if ((m = /^\/api\/rolls\/([\w-]+)$/.exec(path))) {
      const roll = readRoll(m[1]);
      return roll ? sendJson(res, 200, roll) : sendJson(res, 404, { error: "no such roll" });
    }
    if ((m = /^\/api\/rolls\/([\w-]+)\/reject$/.exec(path)) && req.method === "POST") {
      const { file } = await readBody(req);
      rejectFrame(m[1], file);
      return sendJson(res, 200, { ok: true });
    }
    if (path === "/api/jobs" && req.method === "POST") {
      const { script, args = [] } = await readBody(req);
      const job = startJob(script, args);
      return sendJson(res, 200, { id: job.id });
    }
    if (path === "/api/jobs") return sendJson(res, 200, [...jobs.values()].map(({ listeners, lines, ...j }) => ({ ...j, lineCount: lines.length })));
    if ((m = /^\/api\/jobs\/(\d+)\/log$/.exec(path))) {
      const job = jobs.get(m[1]);
      if (!job) return sendJson(res, 404, { error: "no such job" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const line of job.lines) res.write(`data: ${JSON.stringify(line)}\n\n`);
      if (job.done) {
        res.write(`event: done\ndata: ${JSON.stringify({ code: job.code })}\n\n`);
        return res.end();
      }
      job.listeners.add(res);
      req.on("close", () => job.listeners.delete(res));
      return;
    }
    if (path.startsWith("/files/")) return sendFile(res, join(ROOT, "workspace"), decodeURIComponent(path.slice("/files/".length)), req);
    if (serveDist) {
      const rel = path === "/" ? "index.html" : path.slice(1);
      if (existsSync(join(serveDist, rel))) return sendFile(res, serveDist, rel, req);
      return sendFile(res, serveDist, "index.html", req);
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Firstlight server on http://localhost:${PORT}  workspace: ${join(ROOT, "workspace")}${serveDist ? `  serving ${serveDist}` : ""}`);
});
