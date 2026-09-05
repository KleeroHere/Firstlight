import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, STAGES, STAGE_LABEL } from "../api";
import type { Roll, Spend } from "../api";
import { humanError } from "../utils/humanText";
import { showToast } from "../data/toastBus";

/**
 * Every roll, grouped by how far it has got. The stage is not stored anywhere:
 * the server works it out from which files exist, so this page is always as
 * true as the folder is.
 */
export default function RollsPage() {
  const [rolls, setRolls] = useState<Roll[] | null>(null);
  const [spend, setSpend] = useState<Spend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState(72);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const reload = useCallback(() => {
    api
      .rolls()
      .then((r) => {
        setRolls(r.rolls);
        setSpend(r.spend);
      })
      .catch((e) => setError(humanError(e)));
  }, []);
  useEffect(reload, [reload]);

  /** A new roll starts as a scenario with a title card, one scene and a memo. */
  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const res = await api.createRoll(title.trim(), duration);
      showToast({ message: `Created “${title.trim()}” — fill in the scenes`, role: "success" });
      setCreating(false);
      setTitle("");
      navigate(`/roll/${encodeURIComponent(res.id)}`);
    } catch (e) {
      showToast({ message: humanError(e), role: "error" });
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="fl-error">{error}</p>;
  if (!rolls) return <p className="fl-muted">Reading the workspace…</p>;

  const done = rolls.filter((r) => r.stage === "accepted").length;

  return (
    <div className="fl-page">
      <div className="fl-page__head">
        <h1 className="fl-h1">Rolls</h1>
        <p className="fl-muted">
          {rolls.length} in the workspace · {done} accepted
        </p>
        <button type="button" className="fl-button fl-button--primary" onClick={() => setCreating((v) => !v)}>
          {creating ? "Cancel" : "New roll"}
        </button>
      </div>

      {creating && (
        <form
          className="fl-new surface-card"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="fl-field">
            <span className="fl-label">Title — the episode's name, on screen and in the file name</span>
            <input className="fl-input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fog signal check" />
          </label>
          <label className="fl-field fl-field--narrow">
            <span className="fl-label">Target length, s</span>
            <input className="fl-input" type="number" min={20} max={300} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
          </label>
          <button type="submit" className="fl-button fl-button--primary" disabled={busy || !title.trim()}>
            {busy ? "Creating…" : "Create"}
          </button>
          <p className="fl-muted fl-new__hint">
            Creates the scenario with a title card, one scene and a closing memo, then opens it for
            editing. Nothing is generated yet.
          </p>
        </form>
      )}

      <ol className="fl-stages" aria-label="Stages">
        {STAGES.map((s) => (
          <li key={s} className="fl-stages__item">
            <span className="fl-stages__count">{rolls.filter((r) => r.stage === s).length}</span>
            <span className="fl-stages__label">{STAGE_LABEL[s]}</span>
          </li>
        ))}
      </ol>

      {spend && (
        <p className="fl-muted fl-spend">
          Spend so far: <b>${spend.total_usd.toFixed(2)}</b>
          {Object.entries(spend.backends).map(([name, b]) => (
            <span key={name}>
              {" "}
              · {name} ${b.spent_usd.toFixed(2)}
              {b.limit_usd != null ? ` of $${b.limit_usd.toFixed(2)}` : ""}
            </span>
          ))}
        </p>
      )}

      {rolls.length === 0 && !creating && (
        <div className="fl-empty surface-card">
          <h2 className="fl-h2">Nothing here yet</h2>
          <p>
            A roll is one episode. Press <b>New roll</b> and it starts as a scenario — a title card,
            one scene to fill in, a closing card — which you edit on the Scenario tab.
          </p>
          <p className="fl-muted">
            Scenarios written by hand live in <code>workspace/prompts/scenarios/</code> and appear
            here once compiled. The <Link to="/workspace">Workspace</Link> page says what goes where.
          </p>
        </div>
      )}

      <ul className="fl-rolls">
        {rolls.map((r) => {
          const scenes = r.scenes.filter((s) => s.kind === "scene");
          const keyed = scenes.filter((s) => s.frames.length).length;
          const shot = scenes.filter((s) => s.takes.length).length;
          return (
            <li key={r.id} className="fl-roll surface-card">
              <Link to={`/roll/${encodeURIComponent(r.id)}`} className="fl-roll__link">
                <div className="fl-roll__top">
                  <span className={`fl-stage fl-stage--${r.stage}`}>{STAGE_LABEL[r.stage]}</span>
                  {r.verify && <span className={`fl-verdict fl-verdict--${r.verify.verdict}`}>{r.verify.verdict}</span>}
                </div>
                <h2 className="fl-roll__title">{r.title}</h2>
                <p className="fl-roll__meta">
                  {scenes.length} scenes · {keyed} keyed · {shot} shot
                  {r.durationTarget ? ` · target ${r.durationTarget} s` : ""}
                  {r.buildLog ? ` · cut ${Math.round(r.buildLog.totalDuration)} s` : ""}
                </p>
                {r.acceptance && (
                  <p className="fl-muted fl-roll__acceptance">
                    plans: {r.acceptance.accepted} accepted · {r.acceptance.rejected} in reshoot queue
                    {r.acceptance.pending ? ` · ${r.acceptance.pending} awaiting review` : ""}
                    {r.acceptance.unshot ? ` · ${r.acceptance.unshot} not shot` : ""}
                  </p>
                )}
                <div className="fl-progress" aria-hidden="true">
                  <span className="fl-progress__keys" style={{ width: `${scenes.length ? (keyed / scenes.length) * 100 : 0}%` }} />
                  <span className="fl-progress__takes" style={{ width: `${scenes.length ? (shot / scenes.length) * 100 : 0}%` }} />
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
