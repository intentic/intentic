import { CHECK_KINDS, type CheckKind } from "../freshKinds";
import type { CheckMarker } from "../freshSession";
import type { ProofMark } from "./proofSeal";

// WHAT VOUCHES FOR A CARD'S WORK, as stamps: one per check that actually ran on it, side by side in the card's corner
// (CardStamps.vue). Each stamp is a badge whose cut-out symbol says its kind (StampBadge.vue) and whose ink says how
// the check came out. A mark beside the badge means the stamp needs you: the number of open findings, or `!` for a
// failure. A stamp with nothing beside it needs nothing.
// A check that never ran leaves no stamp, and that includes the agent's own check, so a card nobody checked has an
// empty corner. Pure functions over plain data, so the board's card and the rail's row get the same stamps.

// The agent's own check, the command it ran after its last edit, is `self`. It comes before every kind a fresh session
// can run (freshKinds.CHECK_KINDS), which keep the contract's order. That makes the order fixed, so a stamp is in the
// same place on every card.
export type StampKind = `self` | CheckKind;
const STAMP_KINDS: readonly StampKind[] = [`self`, ...CHECK_KINDS];

// How the check came out:
//   passed    the agent's check passed after its last edit, or a review found nothing (or every finding was fixed or
//             set aside)
//   findings  a review left findings open (`open` says how many)
//   failed    the agent's own last check failed, or a fresh session's check stopped before it answered
//   running   a fresh session is checking it now
//   done      a check answered in prose: it ran, and its verdict is in its chat
export type StampOutcome = `passed` | `findings` | `failed` | `running` | `done`;

// Built field by field, so an absent fact is a missing key rather than an `undefined` one; read as `Stamp`.
interface StampFields {
    kind: StampKind;
    outcome: StampOutcome;
    // Findings reported and how many are still open, for a review.
    findings?: number;
    open?: number;
    // The work changed after the check began, so the stamp is about an older version of it.
    stale: boolean;
    // The conversation a check ran in, and whether that was the card's own chat (a typed /code-review). Absent on the
    // agent's own check, which is the card's own turn.
    by?: string;
    own?: boolean;
    // The agent's own check: the command that spoke, and the rendered files it changed without looking at them.
    check?: string;
    unviewed?: number;
}
export type Stamp = Readonly<StampFields>;

// The agent's own check is stamped only when its outcome is known. A turn that changed code and ran nothing leaves
// no stamp: a dashed variant of a passing glyph was a difference nobody could read.
const selfStamp = (proof: ProofMark | undefined): Stamp | undefined => {
    if (proof?.verification !== `verified` && proof?.verification !== `failing`) {
        return undefined;
    }
    const stamp: StampFields = { kind: `self`, outcome: proof.verification === `verified` ? `passed` : `failed`, stale: false };
    if (proof.check !== undefined) {
        stamp.check = proof.check;
    }
    if (proof.unviewed !== undefined) {
        stamp.unviewed = proof.unviewed;
    }
    return stamp;
};

const checkStamp = (check: CheckMarker): Stamp => {
    const outcome: StampOutcome =
        check.state === `clean` ? `passed` : check.state === `findings` ? ((check.open ?? check.findings ?? 0) > 0 ? `findings` : `passed`) : check.state;
    const stamp: StampFields = { kind: check.kind, outcome, stale: check.stale, by: check.by, own: check.own };
    if (check.findings !== undefined) {
        stamp.findings = check.findings;
    }
    if (check.state === `findings`) {
        stamp.open = check.open ?? check.findings ?? 0;
    }
    return stamp;
};

export const stampsOf = (proof: ProofMark | undefined, checks: readonly CheckMarker[]): Stamp[] => {
    const self = selfStamp(proof);
    return [...(self === undefined ? [] : [self]), ...checks.map(checkStamp)].toSorted(
        (a, b) => STAMP_KINDS.indexOf(a.kind) - STAMP_KINDS.indexOf(b.kind),
    );
};

// Whether a stamp asks for the reader: a failure, or findings still open. A stale stamp asks for nothing, since the
// work it judged has moved on (its hover offers to run it again).
const stampNeedsYou = (stamp: Stamp): boolean => !stamp.stale && (stamp.outcome === `failed` || stamp.outcome === `findings`);

// The mark beside the badge: what needs you, or nothing. The count is capped at 9+ so the corner keeps its width.
export const stampMark = (stamp: Stamp): string | undefined => {
    if (!stampNeedsYou(stamp)) {
        return undefined;
    }
    if (stamp.outcome === `failed`) {
        return `!`;
    }
    const open = stamp.open ?? 0;
    return open > 9 ? `9+` : String(open);
};

// The badge's ink. A failure or open findings keep their tone even on a receipt. A pass is green on a live card and
// quiet on a receipt, where it is history. A stale stamp is quiet everywhere. A prose answer is plain ink, because
// green would claim a verdict it never gave.
export const stampTone = (stamp: Stamp, quiet: boolean): string => {
    if (stamp.outcome === `running`) {
        return `text-link`;
    }
    if (stamp.stale) {
        return `text-faint`;
    }
    if (stamp.outcome === `failed`) {
        return `text-danger`;
    }
    if (stamp.outcome === `findings`) {
        return `text-warning`;
    }
    if (stamp.outcome === `passed`) {
        return quiet ? `text-faint` : `text-success`;
    }
    return quiet ? `text-faint` : `text-muted`;
};

// The stamps a corner can show at once. When there are more, the ones that need you are kept first, the rest fold
// into a "+N", and the kept ones stay in their fixed order.
export interface FoldedStamps {
    readonly shown: Stamp[];
    readonly folded: number;
}
export const foldStamps = (stamps: readonly Stamp[], max: number): FoldedStamps => {
    if (stamps.length <= max) {
        return { shown: [...stamps], folded: 0 };
    }
    const kept = new Set([...stamps.filter(stampNeedsYou), ...stamps.filter((stamp) => !stampNeedsYou(stamp))].slice(0, max));
    return { shown: stamps.filter((stamp) => kept.has(stamp)), folded: stamps.length - kept.size };
};
