import { useCallback, useEffect, useState } from "react";
import { api, fileUrl } from "../api";
import type { Decision, Plan, PlanVariant } from "../api";
import { humanError } from "../utils/humanText";
import { showToast } from "../data/toastBus";

/**
 * The acceptance screen: one plan at a time, its first and last keyframe,
 * every clip variant shot for it (plain plan<N>.mp4, or a seed variant
 * plan<N>_s<seed>.mp4), a contact sheet per clip, a defect checklist and a
 * decision. Decisions are written to workspace/<roll>/acceptance.json —
 * flf_batch.mjs and wavespeed_batch.mjs read that file before shooting a
 * plan, so "Redo" here is what tells the next batch run to reshoot it.
 * This board itself never runs a script: it only writes the decision.
 */
export default function AcceptanceBoard({ rollId }: { rollId: string }) {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [defects, setDefects] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .plans(rollId)
      .then((r) => {
        setPlans(r.plans);
        setDefects(r.defects);
      })
      .catch((e) => setError(humanError(e)));
  }, [rollId]);
  useEffect(reload, [reload]);

  if (error)
    return (
      <p className="fl-muted">
        {error}. The acceptance screen needs a plan-list — run{" "}
        <code>python engine/make_plans.py --id {rollId}</code> first.
      </p>
    );
  if (!plans) return <p className="fl-muted">Reading the plan-list…</p>;
  if (plans.length === 0) return <p className="fl-muted">The plan-list has no plans.</p>;

  const bySceneOrder = [...new Set(plans.map((p) => p.scene))];

  return (
    <div className="fl-plans">
      {bySceneOrder.map((scene) => (
        <section key={scene} className="fl-plans__scene">
          <h2 className="fl-plans__scene-id">{scene}</h2>
          {plans
            .filter((p) => p.scene === scene)
            .map((p) => (
              <PlanCard key={p.plan} rollId={rollId} plan={p} defects={defects} onChanged={reload} />
            ))}
        </section>
      ))}
    </div>
  );
}

function PlanCard({ rollId, plan, defects, onChanged }: { rollId: string; plan: Plan; defects: string[]; onChanged: () => void }) {
  return (
    <article className="fl-plan surface-card">
      <header className="fl-plan__head">
        <span className="fl-scene__id">plan{plan.plan}</span>
        {plan.i2v && <span className="fl-tag">i2v — no end key</span>}
        {plan.cycle && <span className="fl-tag">cycle</span>}
        {plan.closeup && <span className="fl-tag">closeup</span>}
        {plan.frames != null && <span className="fl-muted">{plan.frames} frames</span>}
      </header>
      {plan.motion && <p className="fl-scene__anim">{plan.motion}</p>}

      <div className="fl-plan__keys">
        <Keyframe rollId={rollId} label="First" path={plan.master} />
        <Keyframe rollId={rollId} label="Last" path={plan.key} placeholder={plan.i2v ? "i2v plan — no end key by design" : "no key yet"} />
      </div>

      {plan.variants.length === 0 && <p className="fl-muted">No clip shot yet.</p>}
      <div className="fl-variants">
        {plan.variants.map((v) => (
          <VariantCard key={v.key} rollId={rollId} variant={v} defects={defects} onChanged={onChanged} />
        ))}
      </div>
    </article>
  );
}

function Keyframe({ rollId, label, path, placeholder }: { rollId: string; label: string; path: string | null; placeholder?: string }) {
  return (
    <figure className="fl-keyframe">
      {path ? (
        <img src={fileUrl("takes", rollId, ...path.split("/"))} alt="" className="fl-keyframe__img" loading="lazy" />
      ) : (
        <div className="fl-keyframe__empty">{placeholder ?? "not generated yet"}</div>
      )}
      <figcaption className="fl-muted">{label}</figcaption>
    </figure>
  );
}

const DECISIONS: { value: Decision; label: string; className: string }[] = [
  { value: "accepted", label: "Accept", className: "fl-button--primary" },
  { value: "rejected", label: "Reject", className: "fl-button--danger" },
  { value: "redo", label: "Redo with a comment", className: "" },
];

function VariantCard({ rollId, variant, defects, onChanged }: { rollId: string; variant: PlanVariant; defects: string[]; onChanged: () => void }) {
  const [sheet, setSheet] = useState<string | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>(variant.defects);
  const [comment, setComment] = useState(variant.comment);
  const [busy, setBusy] = useState<Decision | null>(null);

  async function genSheet() {
    setSheetBusy(true);
    try {
      const r = await api.contactSheet(rollId, variant.file);
      setSheet(r.sheet);
    } catch (e) {
      showToast({ message: humanError(e), role: "error" });
    } finally {
      setSheetBusy(false);
    }
  }

  function toggleDefect(d: string) {
    setPicked((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));
  }

  async function decide(decision: Decision) {
    setBusy(decision);
    try {
      await api.decide(rollId, variant.key, decision, picked, comment);
      showToast({ message: `${variant.key}: ${decision}`, role: decision === "accepted" ? "success" : "neutral" });
      onChanged();
    } catch (e) {
      showToast({ message: humanError(e), role: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fl-variant">
      <div className="fl-variant__media">
        <video src={fileUrl("takes", rollId, ...variant.file.split("/"))} controls preload="metadata" className="fl-take__media" />
        {sheet ? (
          <img src={fileUrl("takes", rollId, ...sheet.split("/"))} alt="Contact sheet" className="fl-variant__sheet" />
        ) : (
          <button type="button" className="fl-button fl-button--small" disabled={sheetBusy} onClick={() => void genSheet()}>
            {sheetBusy ? "Generating…" : "Contact sheet"}
          </button>
        )}
      </div>
      <div className="fl-variant__body">
        <div className="fl-variant__bar">
          <span className="fl-scene__id">{variant.key}</span>
          {variant.decision && <span className={`fl-decision fl-decision--${variant.decision}`}>{variant.decision}</span>}
        </div>
        <fieldset className="fl-defects">
          <legend className="fl-label">Defects seen</legend>
          {defects.map((d) => (
            <label key={d} className="fl-defect">
              <input type="checkbox" checked={picked.includes(d)} onChange={() => toggleDefect(d)} />
              {d.replace(/-/g, " ")}
            </label>
          ))}
        </fieldset>
        <textarea
          className="fl-input fl-textarea"
          rows={2}
          placeholder="Comment for the next take (what to change, or why it passed)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="fl-actions">
          {DECISIONS.map((d) => (
            <button
              key={d.value}
              type="button"
              className={`fl-button fl-button--small ${d.className}`}
              disabled={busy !== null}
              onClick={() => void decide(d.value)}
            >
              {busy === d.value ? "Saving…" : d.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
