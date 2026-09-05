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
import { spawn, spawnSync, exec } from "node:child_process";
import { rmSync } from "node:fs";
import { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync, statSync, mkdirSync, renameSync, createReadStream } from "node:fs";
import { join, resolve, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isSea } from "node:sea";

// In the packaged .exe (build/build-exe.mjs) this file is bundled to CJS and
// has no meaningful source location — import.meta.url would point inside the
// executable, not at the folders on disk. There, ROOT is the folder the .exe
// itself sits in (engine/ and ui/dist/ are expected right beside it), unless
// --workspace names a different one. In every other case (dev, `npm start`)
// nothing changes: ROOT is still two levels above this file.
function resolveRoot() {
  const wsArg = process.argv.indexOf("--workspace");
  if (wsArg !== -1 && process.argv[wsArg + 1]) return resolve(process.argv[wsArg + 1]);
  if (isSea()) return dirname(process.execPath);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
const ROOT = resolveRoot();
const PORT = Number(process.env.PORT || 7331);
// The packaged .exe always serves ui/dist next to itself; a dev server passes
// --serve explicitly (see start.cmd) and can point at a different folder.
const serveArg = process.argv.includes("--serve") ? process.argv[process.argv.indexOf("--serve") + 1] || "dist" : null;
const serveDist = serveArg ? join(ROOT, "ui", serveArg) : isSea() ? join(ROOT, "ui", "dist") : null;
const shouldOpen = process.argv.includes("--open") || isSea();

// The packaged .exe has no console a person is reliably watching — a Windows
// console window opened for it can flash and close before anyone reads it,
// especially if something throws before the server is even listening. This
// file is the one place left to look; every event below that matters for
// "why didn't it start" goes here too, not just to stdout/stderr.
const LOG_PATH = join(isSea() ? dirname(process.execPath) : ROOT, "firstlight.log");
function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(msg);
  try {
    appendFileSync(LOG_PATH, msg + "\n", "utf8");
  } catch {
    // The log folder itself is unwritable — nothing more to do about it here.
  }
}
log(`starting — root=${ROOT} sea=${isSea()} port=${PORT} argv=${JSON.stringify(process.argv.slice(2))}`);

// engine/pipeline.config.json is the one file everything else here depends
// on; if ROOT is wrong (a bad --workspace, an unexpected install layout) this
// is where it shows up. A server that never starts because of it is the
// worst version of that failure — right now nothing is listening on PORT at
// all, so a browser (this one's own, or an old tab) reports exactly
// "could not reach the server" with no way to see why. So: never let this
// throw before the HTTP server exists — keep going with empty stand-ins and
// serve the reason instead, on every path, until it is fixed.
let CFG = { paths: {} };
let P = {};
let startupError = null;
try {
  CFG = JSON.parse(readFileSync(join(ROOT, "engine", "pipeline.config.json"), "utf8"));
  P = Object.fromEntries(Object.entries(CFG.paths).map(([k, v]) => [k, join(ROOT, v)]));
  log("engine/pipeline.config.json read OK");
} catch (err) {
  startupError = `Could not read engine/pipeline.config.json under "${ROOT}": ${err.message}`;
  log(`STARTUP ERROR: ${startupError}`);
}

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
  // A roll storyboarded per plan (engine/auto_storyboard.py) names its start
  // frames planN_master.png, not sN_shM_frame.png, so the scene-level naming
  // below finds nothing and the Keyframes tab comes up empty even though the
  // roll is fully framed. Map plan -> scene and show those too; they are the
  // same pictures, listed under the scene they belong to.
  const planSpec = readJson(join(ROOT, "workspace", "plans", `${id}.json`));
  const mastersByScene = {};
  for (const p of planSpec?.plans ?? []) {
    if (!p.master || String(p.master).startsWith("chain:")) continue;
    if (!existsSync(join(takesDir, p.master))) continue;
    (mastersByScene[p.scene] ??= []).push(p.master);
  }
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
    frames: [
      ...files.filter((f) => f.startsWith(`${s.id}_sh`) && f.endsWith("_frame.png")).sort(),
      ...(mastersByScene[s.id] ?? []),
    ],
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
    acceptance: summarizeAcceptance(readPlans(id)),
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

/** Spend is one ledger per backend (see engine/spend.mjs, engine/wavespeed_batch.mjs); reports/ is not committed. */
function readSpend() {
  const gemini = readJson(join(ROOT, "reports", "gemini-spend.json"));
  const wavespeed = readJson(join(ROOT, "reports", "wavespeed-spend.json"));
  if (!gemini && !wavespeed) return null;
  const backends = {};
  if (gemini) backends.gemini = { spent_usd: gemini.spent_usd, limit_usd: gemini.limit_usd, runs: gemini.runs?.length ?? 0 };
  if (wavespeed) backends.wavespeed = { spent_usd: wavespeed.spent_usd, runs: wavespeed.runs?.length ?? 0 };
  const total_usd = Number(Object.values(backends).reduce((s, b) => s + (b.spent_usd || 0), 0).toFixed(3));
  return { backends, total_usd };
}

// --- plans and acceptance ------------------------------------------------------

/**
 * The plan-list (engine/make_plans.py output, workspace/plans/<id>.json) is
 * one level below scenes: one plan per shot, with its own keyframes and its
 * own clip variants by seed. Not every roll has one — the example series
 * ships scenes cut from drawn frames instead — so a missing file is not an
 * error, just an empty acceptance screen.
 */
function readPlans(rollId) {
  const spec = readJson(join(ROOT, "workspace", "plans", `${rollId}.json`));
  if (!spec) return null;
  const takesDir = join(P.takes, rollId);
  const flfFiles = list(join(takesDir, "_flf"));
  const acceptance = readAcceptance(rollId);
  const plans = (spec.plans ?? []).map((p) => {
    const rx = new RegExp(`^plan${p.plan}(_[A-Za-z0-9]+)?\\.mp4$`);
    const variants = flfFiles
      .map((f) => ({ f, m: f.match(rx) }))
      .filter((x) => x.m)
      .map((x) => {
        const key = `plan${p.plan}${x.m[1] ?? ""}`;
        const a = acceptance.plans?.[key];
        return { file: `_flf/${x.f}`, key, decision: a?.decision ?? null, defects: a?.defects ?? [], comment: a?.comment ?? "" };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
    let master = null;
    if (String(p.master).startsWith("chain:")) {
      const src = p.master.slice(6);
      if (existsSync(join(takesDir, "_chain", `${src}_last.png`))) master = `_chain/${src}_last.png`;
    } else if (p.master && existsSync(join(takesDir, p.master))) {
      master = p.master;
    }
    const keyRel = `keys/plan${p.plan}_key.png`;
    return {
      plan: p.plan, scene: p.scene, i2v: !!p.i2v, cycle: !!p.cycle, closeup: !!p.closeup,
      motion: p.motion ?? "", frames: p.frames ?? null,
      master, key: existsSync(join(takesDir, keyRel)) ? keyRel : null,
      variants,
    };
  });
  return plans;
}

const DEFECTS = ["extra-person", "extra-hand", "object-moved", "cut-jump", "face-drift", "blur"];

/** How far a roll's plans have got, for the rolls list and the roll header. */
function summarizeAcceptance(plans) {
  if (!plans) return null;
  let accepted = 0, rejected = 0, pending = 0, unshot = 0;
  for (const p of plans) {
    if (!p.variants.length) unshot++;
    else if (p.variants.some((v) => v.decision === "accepted")) accepted++;
    else if (p.variants.every((v) => v.decision === "rejected" || v.decision === "redo")) rejected++;
    else pending++;
  }
  return { total: plans.length, accepted, rejected, pending, unshot, defects: DEFECTS };
}

function acceptancePath(rollId) {
  return join(ROOT, "workspace", rollId, "acceptance.json");
}
function readAcceptance(rollId) {
  return readJson(acceptancePath(rollId)) ?? { plans: {} };
}
/** The engine only ever reads this file; every write comes from here. */
function writeAcceptance(rollId, key, patch) {
  if (!ARG_OK.test(rollId) || !/^[\w-]+$/.test(key)) throw new Error("bad name");
  const p = acceptancePath(rollId);
  const data = readAcceptance(rollId);
  data.plans = data.plans ?? {};
  data.plans[key] = { ...data.plans[key], ...patch, at: new Date().toISOString() };
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
  return data;
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

// --- scenarios: create, edit, delete -----------------------------------------

/**
 * The scenario is YAML, and YAML belongs with the library that understands it.
 * engine/scenario.py is the only thing that reads or writes those files —
 * from here and from the command line alike — so a file edited by hand and a
 * file edited in the browser stay the same shape.
 */
function runPython(args, stdin) {
  return new Promise((resolve) => {
    const child = spawn("python", [join(ROOT, "engine", "scenario.py"), ...args], {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.stderr.on("data", (c) => (err += c.toString("utf8")));
    if (stdin !== undefined) child.stdin.end(JSON.stringify(stdin), "utf8");
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

/** Compiling is what turns an edited scenario into what every other stage reads. */
function compile() {
  return new Promise((resolve) => {
    const child = spawn("python", [join(ROOT, "engine", "build_prompts.py")], {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.stderr.on("data", (c) => (out += c.toString("utf8")));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
  });
}

const slug = (title) =>
  (title || "")
    .toLowerCase()
    .replace(/[Ѐ-ӿ]/g, (ch) => TRANSLIT[ch] ?? "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "roll";

const TRANSLIT = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };

// --- what is in the workspace -------------------------------------------------

/**
 * The workspace, described rather than assumed. "Where do the files go" was the
 * first thing anybody asked, and the honest answer is a list of folders with
 * what is in each one right now.
 */
function readWorkspace() {
  const dirSize = (dir) => {
    if (!existsSync(dir)) return { files: 0, bytes: 0 };
    let files = 0;
    let bytes = 0;
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else {
          files += 1;
          bytes += st.size;
        }
      }
    };
    walk(dir);
    return { files, bytes };
  };
  const entry = (key, dir, what) => ({ key, path: dir.replace(ROOT + "\\", "").replace(ROOT + "/", ""), what, ...dirSize(dir) });
  return {
    root: ROOT,
    config: join("engine", "pipeline.config.json"),
    folders: [
      entry("scenarios", join(ROOT, "workspace", "prompts", "scenarios"), "One YAML per episode. This is the source of truth — everything else is made from it."),
      entry("series", join(ROOT, "workspace", "prompts"), "series.yaml: the style, the cast and their reference sheets, the backgrounds."),
      entry("compiled", P.compiled, "What the scenarios compile into. Every later stage reads these, not the YAML."),
      entry("refs", join(ROOT, "workspace", "refs"), "Reference sheets per character, named as in series.yaml."),
      entry("backgrounds", join(ROOT, "workspace", "backgrounds"), "One image per background."),
      entry("takes", P.takes, "Per roll: keyframes, generated clips, and _rejected/ for what was turned down."),
      entry("build", P.build, "Intermediate segments while an episode is being cut."),
      entry("out", P.out, "Finished episodes, each with its build log and its grade."),
    ],
  };
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

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  if (startupError) {
    res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
    return res.end(
      `<!doctype html><meta charset="utf-8"><title>Firstlight — startup error</title>` +
        `<h1>Firstlight could not start properly</h1><p>${escapeHtml(startupError)}</p>` +
        `<p>Full detail in <code>${escapeHtml(LOG_PATH)}</code>.</p>`,
    );
  }
  try {
    if (path === "/api/rolls" && req.method === "GET") return sendJson(res, 200, { rolls: readRolls(), spend: readSpend() });
    if (path === "/api/workspace") return sendJson(res, 200, readWorkspace());

    // Create a roll: a starter scenario, then compile, so it appears at once.
    if (path === "/api/rolls" && req.method === "POST") {
      const { title, duration = 72 } = await readBody(req);
      if (!String(title ?? "").trim()) return sendJson(res, 400, { error: "a title is needed" });
      const id = slug(title);
      const made = await runPython(["new", "--id", id, "--title", String(title), "--duration", String(Number(duration) || 72)]);
      if (made.code !== 0) return sendJson(res, 400, { error: made.err || made.out || "could not create the scenario" });
      const built = await compile();
      return sendJson(res, 200, { id, compiled: built.code === 0, log: built.out });
    }

    let m;
    // The scenario behind a roll, as JSON. Editing it writes the YAML back and
    // recompiles: an edit nobody compiled would show in the interface and
    // nowhere else, which is worse than not saving at all.
    if ((m = /^\/api\/rolls\/([\w-]+)\/scenario$/.exec(path))) {
      if (req.method === "GET") {
        const r = await runPython(["read", "--id", m[1]]);
        if (r.code !== 0) return sendJson(res, 404, { error: r.err || "no scenario" });
        return sendJson(res, 200, JSON.parse(r.out));
      }
      if (req.method === "PUT") {
        const doc = await readBody(req);
        const w = await runPython(["write", "--id", m[1]], doc);
        if (w.code !== 0) return sendJson(res, 400, { error: w.err || "could not write the scenario" });
        const built = await compile();
        return sendJson(res, 200, { compiled: built.code === 0, log: built.out });
      }
    }
    if ((m = /^\/api\/rolls\/([\w-]+)$/.exec(path)) && req.method === "DELETE") {
      const r = await runPython(["delete", "--id", m[1]]);
      if (r.code !== 0) return sendJson(res, 400, { error: r.err || "could not delete" });
      // Frames and takes are not deleted: they are hours of generation, and a
      // scenario can be written again. Say so rather than quietly removing them.
      const left = existsSync(join(P.takes, m[1]));
      return sendJson(res, 200, { ok: true, takesKept: left });
    }
    if ((m = /^\/api\/rolls\/([\w-]+)$/.exec(path))) {
      const roll = readRoll(m[1]);
      return roll ? sendJson(res, 200, roll) : sendJson(res, 404, { error: "no such roll" });
    }
    if ((m = /^\/api\/rolls\/([\w-]+)\/reject$/.exec(path)) && req.method === "POST") {
      const { file } = await readBody(req);
      rejectFrame(m[1], file);
      return sendJson(res, 200, { ok: true });
    }

    // The acceptance screen: one plan at a time, first/last keyframes, clip
    // variants by seed, a defect checklist, and a decision. See docs/ARCHITECTURE.md.
    if ((m = /^\/api\/rolls\/([\w-]+)\/plans$/.exec(path)) && req.method === "GET") {
      const plans = readPlans(m[1]);
      return plans
        ? sendJson(res, 200, { plans, defects: DEFECTS })
        : sendJson(res, 404, { error: "no plan-list for this roll — run engine/make_plans.py" });
    }
    if ((m = /^\/api\/rolls\/([\w-]+)\/acceptance$/.exec(path)) && req.method === "POST") {
      const { key, decision, defects, comment } = await readBody(req);
      if (!key || !/^plan\d+(_[A-Za-z0-9]+)?$/.test(key)) return sendJson(res, 400, { error: "bad key" });
      if (!["accepted", "rejected", "redo"].includes(decision)) return sendJson(res, 400, { error: "bad decision" });
      const data = writeAcceptance(m[1], key, { decision, defects: Array.isArray(defects) ? defects : [], comment: String(comment ?? "") });
      return sendJson(res, 200, data);
    }
    // Rendered on demand with engine/contact_sheet.mjs and cached beside the
    // clip as <clip>.sheet.png; the script itself skips the work if the sheet
    // is already newer than the clip.
    if ((m = /^\/api\/rolls\/([\w-]+)\/contact-sheet$/.exec(path)) && req.method === "POST") {
      const { clip } = await readBody(req);
      if (!clip || typeof clip !== "string" || clip.includes("..") || clip.includes("\\")) return sendJson(res, 400, { error: "bad clip" });
      const abs = join(P.takes, m[1], clip);
      if (!existsSync(abs)) return sendJson(res, 404, { error: "no such clip" });
      const r = spawnSync("node", [join(ROOT, "engine", "contact_sheet.mjs"), "--clip", abs], { encoding: "utf8" });
      if (r.status !== 0) return sendJson(res, 500, { error: (r.stderr || r.stdout || "contact_sheet.mjs failed").trim().slice(-500) });
      return sendJson(res, 200, { sheet: `${clip}.sheet.png` });
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

function openBrowser(url) {
  try {
    const opener = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    exec(opener, (err) => {
      if (err) log(`could not open a browser at ${url}: ${err.message}`);
    });
  } catch (err) {
    log(`could not open a browser at ${url}: ${err.message}`);
  }
}

// A crash must not take the window with it: the log file is the only thing
// the person has to go on if the console window itself flashes and closes.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log(`port ${PORT} is already in use — Firstlight is very likely already running.`);
    // Whatever is already listening there is, in the ordinary case, this same
    // app started a moment earlier — the friendly outcome for a second
    // double-click is the existing window getting focus, not an error the
    // person has no console open to read. If it turns out to be something
    // else entirely, the tab it opens will say so.
    if (shouldOpen) openBrowser(`http://127.0.0.1:${PORT}`);
    process.exit(0);
  } else {
    log(`STARTUP ERROR: the server could not start: ${err.stack ?? err.message}`);
    process.exit(1);
  }
});

// One bad request must not end the session. Anything unexpected is logged and
// the server carries on; the workspace is on disk, so nothing is lost either way.
process.on("uncaughtException", (err) => log(`Unexpected error: ${err.stack ?? err}`));
process.on("unhandledRejection", (err) => log(`Unexpected rejection: ${err instanceof Error ? (err.stack ?? err.message) : err}`));

server.listen(PORT, () => {
  log(`Firstlight server on http://127.0.0.1:${PORT}  workspace: ${join(ROOT, "workspace")}${serveDist ? `  serving ${serveDist}` : ""}`);
  // The packaged .exe has no terminal a person is watching, so it opens the
  // browser itself instead of printing a URL to click.
  if (shouldOpen) openBrowser(`http://127.0.0.1:${PORT}`);
});
