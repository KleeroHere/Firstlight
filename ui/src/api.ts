// The interface's whole contract with the server. Everything here maps onto a
// folder or a script in the workspace; there is no state the command line
// would not see.

export type Stage = "planned" | "keyed" | "shot" | "assembled" | "accepted";

export interface Scene {
  id: string;
  kind: "scene" | "title" | "divider" | "memo";
  plate: string;
  t: [number, number] | null;
  chars: string[];
  bg: string | null;
  img: string;
  anim: string;
  vo: string;
  frames: string[];
  takes: string[];
  rejected: number;
}

export interface Check {
  section: string;
  verdict: "pass" | "warn" | "fail";
  message: string;
}

/** How far a roll's plan-list has got — see Plan / the Acceptance tab. */
export interface AcceptanceSummary {
  total: number;
  accepted: number;
  rejected: number;
  pending: number;
  unshot: number;
  defects: string[];
}

export interface Roll {
  id: string;
  title: string;
  durationTarget: number | null;
  scenes: Scene[];
  output: string | null;
  buildLog: { createdAt: string; totalDuration: number; voMode: string } | null;
  verify: { verdict: "pass" | "warn" | "fail"; counts: { pass: number; warn: number; fail: number }; checkedAt: string; checks: Check[] } | null;
  priemka: boolean;
  acceptance: AcceptanceSummary | null;
  updatedAt: number;
  stage: Stage;
}

export type Decision = "accepted" | "rejected" | "redo";

/** One clip for one plan, named plan<N>.mp4 or plan<N>_s<seed>.mp4. */
export interface PlanVariant {
  file: string;
  key: string;
  decision: Decision | null;
  defects: string[];
  comment: string;
}

/** One shot in the plan-list (engine/make_plans.py), one level below a scene. */
export interface Plan {
  plan: number;
  scene: string;
  i2v: boolean;
  cycle: boolean;
  closeup: boolean;
  motion: string;
  frames: number | null;
  master: string | null;
  key: string | null;
  variants: PlanVariant[];
}

export interface Job {
  id: string;
  script: string;
  args: string[];
  startedAt: string;
  done: boolean;
  code: number | null;
  lineCount: number;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}
const post = <T,>(url: string, body: unknown) => send<T>("POST", url, body);

/** A scene as it lives in the scenario YAML — the shape the editor writes back. */
export interface ScenarioScene {
  id: string;
  kind?: "scene" | "title" | "divider" | "memo";
  t?: [number, number];
  vo_at?: number;
  motion?: string;
  plate?: string;
  chars?: string[];
  refs?: Record<string, string[]>;
  bg?: string | null;
  img?: string;
  anim?: string;
  memo?: { title: string; items: string[] };
  vo?: string;
}

export interface Scenario {
  id: string;
  title: string;
  scenario?: string;
  duration_target?: number;
  scenes: ScenarioScene[];
}

export interface WorkspaceFolder {
  key: string;
  path: string;
  what: string;
  files: number;
  bytes: number;
}

export interface Workspace {
  root: string;
  config: string;
  folders: WorkspaceFolder[];
}

/** One ledger per backend (engine/spend.mjs, engine/wavespeed_batch.mjs). */
export interface Spend {
  backends: Record<string, { spent_usd: number; limit_usd?: number; runs: number }>;
  total_usd: number;
}

export const api = {
  rolls: () => get<{ rolls: Roll[]; spend: Spend | null }>("/api/rolls"),
  roll: (id: string) => get<Roll>(`/api/rolls/${encodeURIComponent(id)}`),
  workspace: () => get<Workspace>("/api/workspace"),
  createRoll: (title: string, duration: number) =>
    post<{ id: string; compiled: boolean; log: string }>("/api/rolls", { title, duration }),
  deleteRoll: (id: string) => send<{ ok: true; takesKept: boolean }>("DELETE", `/api/rolls/${encodeURIComponent(id)}`),
  scenario: (id: string) => get<Scenario>(`/api/rolls/${encodeURIComponent(id)}/scenario`),
  saveScenario: (id: string, doc: Scenario) =>
    send<{ compiled: boolean; log: string }>("PUT", `/api/rolls/${encodeURIComponent(id)}/scenario`, doc),
  reject: (id: string, file: string) => post<{ ok: true }>(`/api/rolls/${encodeURIComponent(id)}/reject`, { file }),
  plans: (id: string) => get<{ plans: Plan[]; defects: string[] }>(`/api/rolls/${encodeURIComponent(id)}/plans`),
  decide: (id: string, key: string, decision: Decision, defects: string[], comment: string) =>
    post<{ plans: Record<string, unknown> }>(`/api/rolls/${encodeURIComponent(id)}/acceptance`, { key, decision, defects, comment }),
  contactSheet: (id: string, clip: string) =>
    post<{ sheet: string }>(`/api/rolls/${encodeURIComponent(id)}/contact-sheet`, { clip }),
  run: (script: string, args: string[]) => post<{ id: string }>("/api/jobs", { script, args }),
  jobs: () => get<Job[]>("/api/jobs"),
  /** Streams a job's output; resolves with the exit code when it finishes. */
  follow(jobId: string, onLine: (line: string) => void): Promise<number> {
    return new Promise((resolve) => {
      const es = new EventSource(`/api/jobs/${jobId}/log`);
      es.onmessage = (e) => onLine(JSON.parse(e.data));
      es.addEventListener("done", (e) => {
        es.close();
        resolve(JSON.parse((e as MessageEvent).data).code ?? 0);
      });
      es.onerror = () => {
        es.close();
        resolve(-1);
      };
    });
  },
};

export const fileUrl = (...parts: string[]) => "/files/" + parts.map(encodeURIComponent).join("/");

export const STAGE_LABEL: Record<Stage, string> = {
  planned: "Planned",
  keyed: "Keyframes",
  shot: "Takes",
  assembled: "Assembled",
  accepted: "Accepted",
};
export const STAGES: Stage[] = ["planned", "keyed", "shot", "assembled", "accepted"];
