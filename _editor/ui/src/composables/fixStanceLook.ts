import type { IconName } from "../icons/iconSets.js";

/* HOW A FIX STANCE IS DRAWN, keyed by the kind the contract's `fixStance` reads off a fleet summary. The reading
 * lives in @intentic/sandbox-contract so an extension's pure tests can import it; this is the half only a rendering
 * surface needs, and it is here rather than in each surface so the chip beside a red pipeline row and the one on the
 * push question wear the same icon and tint for the same state. Takes the kind as a string, since this kit does not
 * depend on the contract; an unknown kind draws as an ending rather than crashing on `undefined.icon`. */

export interface FixStanceLook {
    readonly icon: IconName;
    readonly spin: boolean;
    // Two fields: a drawer needs ink without the box; spelled out in full since Tailwind can't read `text-${tone}`.
    readonly ink: string;
    readonly chip: string;
}

const ENDED: FixStanceLook = { icon: `exclamation-triangle`, spin: false, ink: `text-warning`, chip: `border-warning/40 hover:bg-warning/10` };

const LOOKS: Readonly<Record<string, FixStanceLook>> = {
    working: { icon: `spinner`, spin: true, ink: `text-info`, chip: `border-info/30 hover:bg-info/10` },
    // `primary-500` is a scale step, not a role, so this tint only works while built in-repo.
    "needs-you": { icon: `exclamation-circle`, spin: false, ink: `text-primary-500`, chip: `border-primary-500/40 hover:bg-overlay` },
    ready: { icon: `download`, spin: false, ink: `text-link`, chip: `border-link/40 hover:bg-link/10` },
    landed: { icon: `check-circle`, spin: false, ink: `text-success`, chip: `border-success/30 hover:bg-success/10` },
    waiting: { icon: `clock`, spin: false, ink: `text-subtle`, chip: `border-line hover:bg-subtle/10` },
    ended: ENDED,
};

export const fixStanceLook = (kind: string): FixStanceLook => LOOKS[kind] ?? ENDED;
