// The shooting guard, in one place.
//
// Every motion prompt this pipeline sends to a video model must carry the same
// clauses, because every clause is a defect somebody already paid for: an
// extra person walked in, a hand appeared with no owner, a door opened behind
// the actor, a mouth flapped over narration, the camera drifted. Keeping the
// text in engine/pipeline.config.json (`production.guard`) and reading it from
// here means the rule is part of the product — a plan-list written by hand, by
// auto_storyboard.py, or by an agent all get the same guard, and a motion line
// that breaks it is refused before it costs a clip.
//
//   import { guardText, applyGuard, checkMotion, negativePrompt } from "./guard.mjs";
//
// applyGuard(motion, cast) returns the motion with the guard prepended (and is
// a no-op if the guard is already there, so it is safe to run twice).
// checkMotion(motion) returns { ok, problems[] } — banned camera/idle verbs,
// a missing guard, an empty action.
import { loadConfig } from "./lib.mjs";

const cfg = loadConfig();
export const GUARD = cfg.production.guard;
export const FRAME = cfg.production.frame;
export const negativePrompt = GUARD.negativePrompt;

export function guardText(n) {
  const who = GUARD.counts[String(n)] ?? `${n} people are`;
  return GUARD.template.replace("{who}", who);
}

// The guard's own first clause, used to detect "already guarded" text.
const MARK = /Exactly (one person is|two people are|three people are|four people are|\d+ people are) in the shot/i;

export function hasGuard(motion) {
  return MARK.test(motion ?? "");
}

export function applyGuard(motion, cast = 1) {
  const m = (motion ?? "").trim();
  if (hasGuard(m)) return m;
  return `${guardText(cast)} ${m}`.trim();
}

// The action half of a motion line — what is left once the guard is stripped.
export function actionOf(motion) {
  const m = (motion ?? "").trim();
  if (!hasGuard(m)) return m;
  const cut = m.indexOf("no cut.");
  return cut === -1 ? m : m.slice(cut + "no cut.".length).trim();
}

export function checkMotion(motion) {
  const problems = [];
  const m = (motion ?? "").trim();
  if (!m) return { ok: false, problems: ["motion is empty"] };
  if (!hasGuard(m)) problems.push("no head-count guard — run applyGuard() or write the 'Exactly N ... in the shot' clause");
  // Banned phrases are looked for in the ACTION half only: the guard's own
  // wording legitimately contains "leaves the frame" ("nobody else enters or
  // leaves the frame"), and scanning the whole line would flag every plan.
  const low = actionOf(m).toLowerCase();
  for (const bad of GUARD.banned) {
    // Word-boundary phrase match: banned entries are plain words and spaces,
    // so no escaping is needed — "breathe" must not fire inside "breather",
    // and "zoom in" only fires as the whole phrase.
    const re = new RegExp("(^|[^a-z])" + bad + "([^a-z]|$)", "i");
    if (re.test(low)) problems.push(`banned motion phrase: "${bad}"`);
  }
  const action = actionOf(m);
  if (action.replace(/[^a-z]/gi, "").length < 12) problems.push("no action after the guard — the clip has nothing to do and will come back a still");
  return { ok: problems.length === 0, problems };
}

// Convenience for a batch script: guard every plan, refuse the run if any
// motion line is unfixable. Returns the plans with guarded motion.
export function guardPlans(plans, { strict = true, log = console.log } = {}) {
  const bad = [];
  const out = plans.map((p) => {
    const cast = p.cast_size ?? (Array.isArray(p.cast) ? p.cast.length : null) ?? (/two people/i.test(p.motion ?? "") ? 2 : 1);
    const motion = applyGuard(p.motion, cast);
    const { ok, problems } = checkMotion(motion);
    if (!ok) bad.push({ plan: p.plan, problems });
    return { ...p, motion };
  });
  if (bad.length) {
    for (const b of bad) log(`plan ${b.plan}: GUARD ${b.problems.join("; ")}`);
    if (strict) throw new Error(`GUARD refused ${bad.length} plan(s) — fix workspace/plans/<id>.json (see docs/PRODUCTION-RULES.md)`);
  }
  return out;
}
