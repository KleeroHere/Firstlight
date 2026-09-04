import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, STAGES, STAGE_LABEL } from "../api";
import type { Roll } from "../api";
import { humanError } from "../utils/humanText";

/**
 * Every roll, grouped by how far it has got. The stage is not stored anywhere:
 * the server works it out from which files exist, so this page is always as
 * true as the folder is.
 */
export default function RollsPage() {
  const [rolls, setRolls] = useState<Roll[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .rolls()
      .then((r) => setRolls(r.rolls))
      .catch((e) => setError(humanError(e)));
  }, []);

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
      </div>

      <ol className="fl-stages" aria-label="Stages">
        {STAGES.map((s) => (
          <li key={s} className="fl-stages__item">
            <span className="fl-stages__count">{rolls.filter((r) => r.stage === s).length}</span>
            <span className="fl-stages__label">{STAGE_LABEL[s]}</span>
          </li>
        ))}
      </ol>

      {rolls.length === 0 && (
        <p className="fl-muted">
          No compiled scenarios yet. Put a series in <code>workspace/prompts/</code> and run{" "}
          <code>python engine/build_prompts.py</code>.
        </p>
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
