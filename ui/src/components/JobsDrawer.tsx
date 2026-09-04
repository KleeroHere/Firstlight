import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * Whatever the engine is doing right now, and what it printed.
 *
 * A job is a script the server spawned; its output streams here line by line.
 * The drawer is the one piece of state the interface owns — and it owns it
 * only until the page reloads, because a finished job's real result is in the
 * workspace, not in this list.
 */

interface LiveJob {
  id: string;
  label: string;
  lines: string[];
  done: boolean;
  code: number | null;
}

type Listener = (jobs: LiveJob[]) => void;
const jobs: LiveJob[] = [];
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l([...jobs]));

/** Start a script and follow it. Resolves with the exit code. */
export async function runJob(script: string, args: string[], label: string): Promise<number> {
  const { id } = await api.run(script, args);
  const job: LiveJob = { id, label, lines: [], done: false, code: null };
  jobs.unshift(job);
  emit();
  const code = await api.follow(id, (line) => {
    job.lines.push(line);
    if (job.lines.length > 400) job.lines.shift();
    emit();
  });
  job.done = true;
  job.code = code;
  emit();
  return code;
}

export default function JobsDrawer() {
  const [list, setList] = useState<LiveJob[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);

  const running = list.filter((j) => !j.done).length;
  if (list.length === 0) return null;

  return (
    <aside className={"fl-drawer" + (open ? " fl-drawer--open" : "")}>
      <button type="button" className="fl-drawer__toggle" onClick={() => setOpen((o) => !o)}>
        {running ? `${running} running` : "Engine idle"} · {list.length} job{list.length === 1 ? "" : "s"}
        <span className="fl-drawer__chev">{open ? "▾" : "▴"}</span>
      </button>
      {open && (
        <div className="fl-drawer__body">
          {list.map((j) => (
            <details key={j.id} className="fl-job" open={!j.done}>
              <summary className="fl-job__summary">
                <span className={"fl-job__dot" + (j.done ? (j.code === 0 ? " fl-job__dot--ok" : " fl-job__dot--bad") : " fl-job__dot--live")} />
                {j.label}
                <span className="fl-muted"> · {j.done ? `exit ${j.code}` : "running"}</span>
              </summary>
              <pre className="fl-job__log">{j.lines.join("\n")}</pre>
            </details>
          ))}
        </div>
      )}
    </aside>
  );
}
