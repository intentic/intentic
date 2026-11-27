import type { Finding } from "./wire";

/* WHAT A FINDING OWES THE READER, the one rule the badge, the view's sections and the agent's tool all count by. Pipelines
   learned it the hard way: a tile that stays red over work an agent is already doing teaches the reader to stop looking.
   So a finding counts only when its next move is the reader's: nobody is on it, its agent stopped or handed it back,
   its agent waits on an answer or a review, its fix landed and still has to ship, or no commit fixes it and the step is
   the owner's. An agent working on it, or waiting on its allowance, needs nobody. Decisions, setup advice and alerts that
   are not firing are shown, never counted. */

export type Owed =
    // A fix nobody is on.
    | `unowned`
    // Its agent ended without a fix that holds.
    | `handed-back`
    // Its agent waits on the reader: a question, a plan, a permission.
    | `answer`
    // A fix is held on its agent's branch, waiting to be reviewed and landed.
    | `review`
    // The fix is in the workspace: ship it, then mark it fixed so PostHog reopens it if it comes back.
    | `landed`
    // No commit fixes it: the owner's step, by PostHog's word or its agent's.
    | `step`;

export const isSnoozed = (finding: Finding, now: number): boolean => finding.snoozedUntil !== undefined && finding.snoozedUntil > now;

export const owedOf = (finding: Finding, now: number): Owed | undefined => {
    if (isSnoozed(finding, now)) {
        return undefined;
    }
    if (finding.lane === `step` || finding.agent?.ownerStep !== undefined) {
        return `step`;
    }
    if (finding.lane !== `fix`) {
        return undefined;
    }
    switch (finding.agent?.stance) {
        case undefined:
            return `unowned`;
        case `working`:
        case `waiting`:
            return undefined;
        case `needs-you`:
            return `answer`;
        case `ready`:
            return `review`;
        case `landed`:
            return `landed`;
        case `ended`:
            return `handed-back`;
    }
};

export interface Attention {
    readonly owed: number;
    // Being fixed by an agent right now: shown beside the count, never in it.
    readonly handled: number;
    readonly tone: `danger` | `warning` | `info`;
}

/** The badge's reading: how many findings owe the reader, how many agents are on the rest, and how loud to be. Danger
 *  only for something critical nobody is on (or whose agent gave up); a warning for the rest of what is serious or the
 *  owner's own step; the resting tone otherwise. */
export const attentionOf = (findings: readonly Finding[], now: number): Attention => {
    let owed = 0;
    let handled = 0;
    let tone: Attention[`tone`] = `info`;
    for (const finding of findings) {
        const owes = owedOf(finding, now);
        if (owes === undefined) {
            handled += finding.lane === `fix` && finding.agent !== undefined && !isSnoozed(finding, now) ? 1 : 0;
            continue;
        }
        owed += 1;
        if (finding.severity === `critical` && (owes === `unowned` || owes === `handed-back`)) {
            tone = `danger`;
        } else if (tone !== `danger` && (finding.severity !== `info` || owes === `step`)) {
            tone = `warning`;
        }
    }
    return { owed, handled, tone };
};
