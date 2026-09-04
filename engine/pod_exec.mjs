// Выполнение shell-команд на поде RunPod через открытый Jupyter kernel API.
// Нужен, когда SSH до пода недоступен: JupyterLab на 8888 отвечает без токена,
// и его ядро python3 работает как удалённая оболочка.
//
//   node engine/pod_exec.mjs "<команда>" [таймаутСек]
//
// Идентификатор пода берётся из переменной POD_ID (при пересоздании пода
// менять её, а не код). Без переменной скрипт не запускается — умолчания у него нет нарочночанию.
// Ядро переиспользуется между вызовами — его id лежит во временном каталоге.
const POD = process.env.POD_ID;
if (!POD) {
  console.error("Set POD_ID to the RunPod pod identifier (the part before -8888.proxy.runpod.net).");
  process.exit(2);
}
const BASE = `https://${POD}-8888.proxy.runpod.net`;
const WS = BASE.replace("https://", "wss://");
const cmd = process.argv[2];
const timeoutSec = Number(process.argv[3] || 300);
if (!cmd) { console.error("нет команды"); process.exit(2); }

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const kernelsFile = path.join(os.tmpdir(), "aurora-pod-kernel.txt");

// Jupyter требует _xsrf для POST: берём куку с обычной страницы.
const seed = await fetch(`${BASE}/lab`);
const cookies = (seed.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]);
const xsrf = (cookies.find((c) => c.startsWith("_xsrf=")) || "").split("=")[1] || "";
const auth = { Cookie: cookies.join("; "), "X-XSRFToken": xsrf };

let kid = null;
if (fs.existsSync(kernelsFile)) {
  const saved = fs.readFileSync(kernelsFile, "utf8").trim();
  const r = await fetch(`${BASE}/api/kernels/${saved}`, { headers: auth });
  if (r.ok) kid = saved;
}
if (!kid) {
  const r = await fetch(`${BASE}/api/kernels`, {
    method: "POST", headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ name: "python3" }),
  });
  if (!r.ok) { console.error("не создан kernel:", r.status, await r.text()); process.exit(1); }
  kid = (await r.json()).id;
  fs.writeFileSync(kernelsFile, kid);
}

const session = "aurora-agent";
const msgId = "m" + process.pid + "-" + process.hrtime.bigint();
const code = [
  "import subprocess, sys",
  "p = subprocess.run(" + JSON.stringify(cmd) + ", shell=True, capture_output=True, text=True, errors='replace')",
  "sys.stdout.write(p.stdout)",
  "sys.stdout.write(p.stderr)",
  "print('__EXIT__', p.returncode)",
].join("\n");

const ws = new WebSocket(`${WS}/api/kernels/${kid}/channels?session_id=${session}`);
let exitCode = 0;
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("таймаут " + timeoutSec + "с")), timeoutSec * 1000);
  ws.onopen = () => {
    ws.send(JSON.stringify({
      header: { msg_id: msgId, username: "agent", session, msg_type: "execute_request", version: "5.3" },
      parent_header: {}, metadata: {},
      content: { code, silent: false, store_history: false, user_expressions: {}, allow_stdin: false, stop_on_error: true },
      channel: "shell",
    }));
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.parent_header?.msg_id !== msgId) return;
    if (m.msg_type === "stream") process.stdout.write(m.content.text);
    if (m.msg_type === "error") { process.stdout.write(m.content.traceback.join("\n") + "\n"); exitCode = 1; }
    if (m.msg_type === "status" && m.content.execution_state === "idle") { clearTimeout(timer); resolve(); }
  };
  ws.onerror = (e) => { clearTimeout(timer); reject(new Error("ws: " + (e.message || e.type))); };
});
try { await done; } catch (e) { console.error("ОШИБКА:", e.message); exitCode = 1; }
ws.close();
process.exit(exitCode);
