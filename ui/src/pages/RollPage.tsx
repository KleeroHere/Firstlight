import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fileUrl, STAGE_LABEL } from "../api";
import type { Roll, Scene } from "../api";
import { humanError } from "../utils/humanText";
import { runJob } from "../components/JobsDrawer";
import ScenarioEditor from "../components/ScenarioEditor";
import AcceptanceBoard from "../components/AcceptanceBoard";
import { showToast } from "../data/toastBus";

/**
 * One roll: the acceptance screen. This is the page that used to be a static
 * priemka.html beside the frames — the same frame, the same cast line, the
 * same checklist — with the decisions wired to the engine instead of to a
 * file manager.
 *
 * Reject moves the frame to _rejected/, exactly where the engine already keeps
 * rejected frames, so nothing here invents a new convention.
 */
export default function RollPage() {
  const { id = "" } = useParams();
  const [roll, setRoll] = useState<Roll | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"scenario" | "frames" | "takes" | "acceptance" | "episode" | null>(null);
  const navigate = useNavigate();

  const reload = useCallback(() => {
    api
      .roll(id)
      .then((r) => {
        setRoll(r);
        // Open where there is something to do. A roll nobody has shot yet has
        // empty keyframe and take tabs; what it needs is the scenario written.
        setTab((current) => current ?? (r.stage === "planned" ? "scenario" : "frames"));
      })
      .catch((e) => setError(humanError(e)));
  }, [id]);
  useEffect(reload, [reload]);

  if (error) return <p className="fl-error">{error}</p>;
  if (!roll) return <p className="fl-muted">Reading the roll…</p>;

  const scenes = roll.scenes.filter((s) => s.kind === "scene");

  /**
   * Deleting removes the scenario and its compiled copy — not the frames and
   * takes. Those are hours of generation and a scenario can be written again,
   * so the confirmation says exactly what goes and what stays.
   */
  async function remove() {
    if (!roll) return;
    const ok = window.confirm(
      `Delete the scenario for “${roll.title}”?

` +
        "Keyframes and takes stay in the workspace — only the scenario and its compiled copy go.",
    );
    if (!ok) return;
    try {
      const res = await api.deleteRoll(roll.id);
      showToast({
        message: res.takesKept ? "Scenario deleted — frames and takes kept" : "Scenario deleted",
        role: "neutral",
      });
      navigate("/");
    } catch (e) {
      showToast({ message: humanError(e), role: "error" });
    }
  }

  async function run(script: string, args: string[], label: string) {
    const code = await runJob(script, args, label);
    if (code === 0) showToast({ message: `${label}: done`, role: "success" });
    else showToast({ message: `${label}: exit ${code}`, role: "error" });
    reload();
  }

  return (
    <div className="fl-page">
      <div className="fl-page__head">
        <div>
          <Link to="/" className="fl-back">
            ← Rolls
          </Link>
          <h1 className="fl-h1">{roll.title}</h1>
          <p className="fl-muted">
            <span className={`fl-stage fl-stage--${roll.stage}`}>{STAGE_LABEL[roll.stage]}</span> · {scenes.length} scenes
            {roll.durationTarget ? ` · target ${roll.durationTarget} s` : ""}
            {roll.acceptance
              ? ` · ${roll.acceptance.accepted}/${roll.acceptance.total} plans accepted` +
                (roll.acceptance.rejected ? `, ${roll.acceptance.rejected} in the reshoot queue` : "")
              : ""}
          </p>
        </div>
        <div className="fl-actions">
          <button type="button" className="fl-button" onClick={() => run("keys", ["--id", roll.id], "Keyframes")}>
            Generate keyframes
          </button>
          <button type="button" className="fl-button" onClick={() => run("synthetic", ["--id", roll.id], "Synthetic takes")}>
            Synthetic takes
          </button>
          <button type="button" className="fl-button fl-button--primary" onClick={() => run("assemble", ["--id", roll.id, "--placeholder-vo"], "Assemble")}>
            Assemble
          </button>
          {roll.output && (
            <button type="button" className="fl-button" onClick={() => run("verify", [`workspace/out/${roll.output}`], "Verify")}>
              Verify
            </button>
          )}
          <button
            type="button"
            className="fl-button fl-button--danger"
            onClick={() => void remove()}
            title="Deletes the scenario. Frames and takes stay on disk."
          >
            Delete
          </button>
        </div>
      </div>

      <nav className="fl-tabs" aria-label="Sections">
        {(["scenario", "frames", "takes", "acceptance", "episode"] as const).map((t) => (
          <button key={t} type="button" className={"fl-tab" + (tab === t ? " fl-tab--active" : "")} onClick={() => setTab(t)}>
            {t === "scenario"
              ? "Scenario"
              : t === "frames"
                ? "Keyframes"
                : t === "takes"
                  ? "Takes"
                  : t === "acceptance"
                    ? "Acceptance"
                    : "Episode"}
          </button>
        ))}
      </nav>

      {tab === "scenario" && <ScenarioEditor rollId={roll.id} onSaved={reload} />}

      {tab === "frames" && (
        <div className="fl-scenes">
          {scenes.map((s) => (
            <SceneCard key={s.id} roll={roll} scene={s} onChanged={reload} />
          ))}
        </div>
      )}

      {tab === "takes" && (
        <div className="fl-scenes">
          {scenes.map((s) => (
            <section key={s.id} className="fl-scene surface-card">
              <header className="fl-scene__head">
                <span className="fl-scene__id">{s.id}</span>
                <span className="fl-scene__plate">{s.plate}</span>
              </header>
              {s.takes.length === 0 && <p className="fl-muted">No takes yet.</p>}
              <div className="fl-takes">
                {s.takes.map((t) => (
                  <figure key={t} className="fl-take">
                    {/\.mp4$/i.test(t) ? (
                      <video src={fileUrl("takes", roll.id, t)} controls preload="metadata" className="fl-take__media" />
                    ) : (
                      <img src={fileUrl("takes", roll.id, t)} alt="" className="fl-take__media" />
                    )}
                    <figcaption className="fl-take__name">{t}</figcaption>
                  </figure>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {tab === "acceptance" && <AcceptanceBoard rollId={roll.id} />}

      {tab === "episode" && (
        <div className="fl-episode">
          {!roll.output && <p className="fl-muted">Not assembled yet. When every scene has a take, press Assemble.</p>}
          {roll.output && (
            <>
              <video src={fileUrl("out", roll.output)} controls className="fl-episode__video" />
              {roll.buildLog && (
                <p className="fl-muted">
                  Cut {new Date(roll.buildLog.createdAt).toLocaleString()} · {Math.round(roll.buildLog.totalDuration)} s · voice-over: {roll.buildLog.voMode}
                </p>
              )}
              {roll.verify ? <VerifyReport roll={roll} /> : <p className="fl-muted">Not verified yet — press Verify.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SceneCard({ roll, scene, onChanged }: { roll: Roll; scene: Scene; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function reject(file: string) {
    setBusy(file);
    try {
      await api.reject(roll.id, file);
      showToast({ message: `${file} moved to _rejected/`, role: "neutral" });
      onChanged();
    } catch (e) {
      showToast({ message: humanError(e), role: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="fl-scene surface-card">
      <header className="fl-scene__head">
        <span className="fl-scene__id">{scene.id}</span>
        <span className="fl-scene__plate">{scene.plate}</span>
        {scene.t && (
          <span className="fl-muted">
            {scene.t[0]}–{scene.t[1]} s
          </span>
        )}
      </header>
      <p className="fl-scene__cast">
        {scene.chars.length ? scene.chars.join(", ") : "nobody in frame"}
        {scene.bg ? ` · ${scene.bg}` : ""}
        {scene.rejected ? ` · ${scene.rejected} rejected` : ""}
      </p>
      <p className="fl-scene__img">{scene.img}</p>
      {scene.anim && <p className="fl-scene__anim">↳ {scene.anim}</p>}
      {scene.frames.length === 0 && <p className="fl-muted">No keyframes yet.</p>}
      <div className="fl-frames">
        {scene.frames.map((f) => (
          <figure key={f} className="fl-frame">
            <a href={fileUrl("takes", roll.id, f)} target="_blank" rel="noreferrer">
              <img src={fileUrl("takes", roll.id, f)} alt="" className="fl-frame__img" loading="lazy" />
            </a>
            <figcaption className="fl-frame__bar">
              <span className="fl-frame__name">{f}</span>
              <button type="button" className="fl-button fl-button--small fl-button--danger" disabled={busy === f} onClick={() => reject(f)}>
                Reject
              </button>
            </figcaption>
          </figure>
        ))}
      </div>
      {scene.frames.length > 0 && (
        <ul className="fl-checklist">
          <li>exactly {Math.max(scene.chars.length, 0)} {scene.chars.length === 1 ? "person" : "people"}, nobody extra</li>
          <li>faces and clothes as on the reference sheets</li>
          <li>furniture as in the background, nothing added</li>
          <li>no readable text</li>
          <li>nobody cut by the frame edge</li>
        </ul>
      )}
    </section>
  );
}

function VerifyReport({ roll }: { roll: Roll }) {
  const v = roll.verify!;
  const sections = [...new Set(v.checks.map((c) => c.section))];
  return (
    <section className="fl-verify surface-card">
      <header className="fl-verify__head">
        <span className={`fl-verdict fl-verdict--${v.verdict}`}>{v.verdict}</span>
        <span className="fl-muted">
          {v.counts.pass} pass · {v.counts.warn} warn · {v.counts.fail} fail · {new Date(v.checkedAt).toLocaleString()}
        </span>
      </header>
      {sections.map((sec) => (
        <div key={sec} className="fl-verify__section">
          <h3 className="fl-verify__title">{sec}</h3>
          <ul className="fl-verify__list">
            {v.checks
              .filter((c) => c.section === sec)
              .map((c, i) => (
                <li key={i} className={`fl-check fl-check--${c.verdict}`}>
                  {c.message}
                </li>
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
