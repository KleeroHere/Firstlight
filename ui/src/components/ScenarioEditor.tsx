import { useEffect, useState } from "react";
import { api } from "../api";
import type { Scenario, ScenarioScene } from "../api";
import { humanError } from "../utils/humanText";
import { showToast } from "../data/toastBus";

/**
 * The scenario, edited in place.
 *
 * This is the only screen that writes rather than reads. Saving does two
 * things at once — writes the YAML and recompiles it — because an edit that
 * was saved but not compiled would show here and nowhere else, which is worse
 * than not saving at all.
 *
 * The YAML stays the source of truth and stays hand-editable: the same file
 * can be opened in a text editor between two visits here, and the writer keeps
 * its shape (prose as block text, timings on one line, keys in order).
 */
export default function ScenarioEditor({ rollId, onSaved }: { rollId: string; onSaved: () => void }) {
  const [doc, setDoc] = useState<Scenario | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDoc(null);
    setDirty(false);
    api
      .scenario(rollId)
      .then(setDoc)
      .catch((e) => setError(humanError(e)));
  }, [rollId]);

  // Leaving with unsaved changes loses them: the editor holds the only copy
  // until Save writes the file.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (error) return <p className="fl-error">{error}</p>;
  if (!doc) return <p className="fl-muted">Reading the scenario…</p>;

  function edit(fn: (d: Scenario) => void) {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
  }

  function editScene(i: number, patch: Partial<ScenarioScene>) {
    edit((d) => Object.assign(d.scenes[i], patch));
  }

  /** A new scene lands before the closing card, where a step belongs. */
  function addScene() {
    edit((d) => {
      const used = new Set(d.scenes.map((s) => s.id));
      let n = 1;
      while (used.has(`s${n}`)) n += 1;
      const last = d.scenes[d.scenes.length - 1];
      const at = last?.kind === "memo" ? d.scenes.length - 1 : d.scenes.length;
      const start = d.scenes[at - 1]?.t?.[1] ?? 0;
      d.scenes.splice(at, 0, {
        id: `s${n}`,
        t: [start, start + 16],
        vo_at: 0.5,
        motion: "anim",
        plate: `Step ${n}`,
        chars: [],
        bg: null,
        img: "What is in the frame: who, where, doing what, and how close the shot is.",
        anim: "The one movement this shot makes, start to finish.",
        vo: "What the narrator says over this scene.",
      });
    });
  }

  async function save() {
    if (!doc) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.saveScenario(rollId, doc);
      setDirty(false);
      showToast({
        message: res.compiled ? "Saved and compiled" : "Saved, but it did not compile — see the log",
        role: res.compiled ? "success" : "error",
      });
      if (!res.compiled) setError(res.log);
      onSaved();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fl-editor">
      <div className="fl-editor__bar">
        <label className="fl-field fl-field--inline">
          <span className="fl-label">Title</span>
          <input className="fl-input" value={doc.title} onChange={(e) => edit((d) => void (d.title = e.target.value))} />
        </label>
        <label className="fl-field fl-field--inline fl-field--narrow">
          <span className="fl-label">Target, s</span>
          <input
            className="fl-input"
            type="number"
            value={doc.duration_target ?? 0}
            onChange={(e) => edit((d) => void (d.duration_target = Number(e.target.value)))}
          />
        </label>
        <span className="fl-spacer" />
        {dirty && <span className="fl-muted">unsaved</span>}
        <button type="button" className="fl-button" onClick={addScene}>
          Add scene
        </button>
        <button type="button" className="fl-button fl-button--primary" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save and compile"}
        </button>
      </div>

      {doc.scenes.map((s, i) => (
        <section key={i} className="fl-scene surface-card">
          <header className="fl-scene__head">
            <input
              className="fl-input fl-input--id"
              value={s.id}
              onChange={(e) => editScene(i, { id: e.target.value })}
              aria-label="Scene id"
            />
            <select
              className="fl-input fl-input--kind"
              value={s.kind ?? "scene"}
              onChange={(e) => editScene(i, { kind: e.target.value as ScenarioScene["kind"] })}
              aria-label="Scene kind"
            >
              <option value="scene">scene</option>
              <option value="title">title card</option>
              <option value="divider">divider</option>
              <option value="memo">memo card</option>
            </select>
            <input
              className="fl-input fl-input--num"
              type="number"
              value={s.t?.[0] ?? 0}
              onChange={(e) => editScene(i, { t: [Number(e.target.value), s.t?.[1] ?? 0] })}
              aria-label="Scene start"
            />
            <span className="fl-muted">–</span>
            <input
              className="fl-input fl-input--num"
              type="number"
              value={s.t?.[1] ?? 0}
              onChange={(e) => editScene(i, { t: [s.t?.[0] ?? 0, Number(e.target.value)] })}
              aria-label="Scene end"
            />
            <span className="fl-spacer" />
            <button
              type="button"
              className="fl-button fl-button--small fl-button--danger"
              onClick={() => edit((d) => void d.scenes.splice(i, 1))}
            >
              Remove
            </button>
          </header>

          <label className="fl-field">
            <span className="fl-label">Caption on screen</span>
            <input className="fl-input" value={s.plate ?? ""} onChange={(e) => editScene(i, { plate: e.target.value })} />
          </label>

          {(s.kind ?? "scene") === "scene" && (
            <>
              <div className="fl-field-row">
                <label className="fl-field">
                  <span className="fl-label">In frame — character ids from series.yaml, comma separated</span>
                  <input
                    className="fl-input"
                    value={(s.chars ?? []).join(", ")}
                    onChange={(e) =>
                      editScene(i, { chars: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })
                    }
                  />
                </label>
                <label className="fl-field">
                  <span className="fl-label">Background id</span>
                  <input className="fl-input" value={s.bg ?? ""} onChange={(e) => editScene(i, { bg: e.target.value || null })} />
                </label>
              </div>
              <label className="fl-field">
                <span className="fl-label">What the frame shows</span>
                <textarea className="fl-input fl-textarea" rows={3} value={s.img ?? ""} onChange={(e) => editScene(i, { img: e.target.value })} />
              </label>
              <label className="fl-field">
                <span className="fl-label">The one movement — start to finish, inside the clip</span>
                <input className="fl-input" value={s.anim ?? ""} onChange={(e) => editScene(i, { anim: e.target.value })} />
              </label>
            </>
          )}

          {s.kind === "memo" && (
            <label className="fl-field">
              <span className="fl-label">Memo points, one per line</span>
              <textarea
                className="fl-input fl-textarea"
                rows={3}
                value={(s.memo?.items ?? []).join("\n")}
                onChange={(e) =>
                  editScene(i, {
                    memo: { title: s.memo?.title ?? s.plate ?? "", items: e.target.value.split("\n").filter((x) => x.trim()) },
                  })
                }
              />
            </label>
          )}

          <label className="fl-field">
            <span className="fl-label">Narration</span>
            <textarea className="fl-input fl-textarea" rows={2} value={s.vo ?? ""} onChange={(e) => editScene(i, { vo: e.target.value })} />
          </label>
        </section>
      ))}
    </div>
  );
}
