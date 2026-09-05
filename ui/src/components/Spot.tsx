/**
 * Small illustrative spots for the empty states — the same harbour the demo
 * episodes are drawn in, reduced to a few shapes. Inline SVG, no files and no
 * network: colours come from the palette so both lightnesses work, and the
 * whole thing is decorative (aria-hidden), never the only way to read a state.
 */
import type { ReactElement, ReactNode } from "react";

type Kind = "horizon" | "lantern" | "reel";

const SPOTS: Record<Kind, ReactElement> = {
  // nothing here yet — an empty sea with the sun just up
  horizon: (
    <>
      <path d="M8 34a24 24 0 0 1 48 0Z" className="fl-spot__sky" />
      <path d="M23 34a9 9 0 0 1 18 0Z" className="fl-spot__hot" />
      <rect x="6" y="34" width="52" height="2.6" rx="1.3" className="fl-spot__line" />
      <rect x="26" y="42" width="12" height="2.6" rx="1.3" className="fl-spot__hot" />
      <rect x="21" y="49" width="22" height="2.6" rx="1.3" className="fl-spot__hot" opacity=".7" />
      <rect x="16" y="56" width="32" height="2.6" rx="1.3" className="fl-spot__hot" opacity=".45" />
    </>
  ),
  // nothing generated yet — the lens, unlit
  lantern: (
    <>
      <circle cx="32" cy="32" r="25" className="fl-spot__ring" />
      <circle cx="32" cy="32" r="17" className="fl-spot__ring" />
      <circle cx="32" cy="32" r="9" className="fl-spot__ring" />
      <circle cx="32" cy="32" r="4" className="fl-spot__hot" />
    </>
  ),
  // nothing shot yet — a frame of film with no picture in it
  reel: (
    <>
      <rect x="7" y="17" width="50" height="30" rx="5" className="fl-spot__ring" />
      <rect x="12" y="9" width="9" height="5" rx="2" className="fl-spot__hot" />
      <rect x="27" y="9" width="9" height="5" rx="2" className="fl-spot__hot" opacity=".5" />
      <rect x="42" y="9" width="9" height="5" rx="2" className="fl-spot__hot" opacity=".5" />
      <rect x="12" y="50" width="9" height="5" rx="2" className="fl-spot__hot" opacity=".5" />
      <rect x="27" y="50" width="9" height="5" rx="2" className="fl-spot__hot" opacity=".5" />
      <rect x="42" y="50" width="9" height="5" rx="2" className="fl-spot__hot" opacity=".5" />
    </>
  ),
};

export default function Spot({ kind, size = 64 }: { kind: Kind; size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className="fl-spot" aria-hidden="true" focusable="false">
      {SPOTS[kind]}
    </svg>
  );
}

/** An empty state that is one line of text with a spot beside it. */
export function EmptyLine({ kind, children }: { kind: Kind; children: ReactNode }) {
  return (
    <p className="fl-emptyline">
      <Spot kind={kind} size={34} />
      <span className="fl-muted">{children}</span>
    </p>
  );
}
