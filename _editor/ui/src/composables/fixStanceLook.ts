import type { IconName } from "../icons/iconSets.js";
import { type Tone, toneHover, toneInk, toneRim } from "../lib/tone.js";

/* HOW A FIX STANCE IS DRAWN, keyed by the kind the contract's `fixStance` reads off a fleet summary. */

export interface FixStanceLook {
    readonly icon: IconName;
    readonly spin: boolean;
    // Two fields: a drawer needs ink without the box. Both come from tone.ts, which spells every tone out in full
    // since Tailwind can't read `text-${tone}`.
    readonly ink: string;
    readonly chip: string;
}

// The chip is a `.ui-chip`, which keeps its own resting fill: it takes the tone's rim and the tone arriving under the
// pointer, never the tint's fill.

const look = (tone: Tone, icon: IconName, spin = false): FixStanceLook => ({
    icon,
    spin,
    ink: toneInk(tone),
    chip: toneRim(tone, `strong`, toneHover(tone)),
});

const ENDED: FixStanceLook = look(`warning`, `exclamation-triangle`);

const LOOKS: Readonly<Record<string, FixStanceLook>> = {
    working: look(`info`, `spinner`, true),
    // `primary` is a scale step, not a role, so its tint exists only because tone.ts is built in this repo.
    "needs-you": look(`primary`, `exclamation-circle`),
    // `link` is not a tone: the one stance that is an offer to follow, in the link colour.
    ready: { icon: `download`, spin: false, ink: `text-link`, chip: `border-link/40 hover:bg-link/10` },
    landed: look(`success`, `check-circle`),
    waiting: look(`neutral`, `clock`),
    ended: ENDED,
};

export const fixStanceLook = (kind: string): FixStanceLook => LOOKS[kind] ?? ENDED;
