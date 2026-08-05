/* HOW WE ASK. Every prompt this workspace generates from a measurement — a hotspot's refactor, a chore's sweep —
 * has the same four parts, in the same order, for the same reasons:
 *
 *   subject    the one line that says what is being worked on. First, because a model that reads the rationale
 *              before the target starts planning against a subject it has not been told yet.
 *   why        the NUMBERS, quoted exactly as the panel shows them, then what they mean. Exact so the agent and
 *              the person are arguing about one set of facts; the agent can and should recount them.
 *   goal       what shape to move towards — never a design. Whoever generated this prompt has not read the code,
 *              so a prescribed solution from out here is a guess wearing an instruction's clothes.
 *   done       falsifiable, and checkable by the agent itself. The same resident engine that produced the
 *              measurement answers `iq` in the agent's own worktree, so "run it again and see" is available and
 *              "I have finished" is not something it has to be taken at its word on.
 *
 * The invariants sit between goal and done because they are the constraints on HOW, and they are stated in full
 * every time rather than assumed. Each one is a specific way the turn fails without it — they are here because
 * they were each learned from a diff nobody could review. */

export interface Ask {
    readonly subject: string;
    readonly why: string;
    readonly diagnosis: string;
    readonly goal: string;
    readonly invariants: string;
    readonly done: string;
}

export const composeAsk = ({ subject, why, diagnosis, goal, invariants, done }: Ask): string =>
    [subject, `Why: ${why} ${diagnosis}`, goal, `${invariants} ${done}`].join(`\n\n`);

/* Said to every turn a TOOL woke, and the reason the maintenance surface can point agents at tool output at all.
 * A tool reporting N findings is not reporting N problems: knip is confidently wrong about anything reachable
 * from outside the repo, jscpd counts generated files, an advisory in a build-time dependency is not the same
 * risk as one in a running service. A chore that mechanically actions the whole list is worse than no chore —
 * it makes noisy, confident, wrong changes at three in the morning, and the next person has to review a diff
 * whose author had no opinion about it. */
export const TRIAGE_NOTE =
    `The measurement woke you; it did not decide anything. Read the repository before you touch it, and treat every ` +
    `finding as a claim to verify rather than a task to execute. If a finding is wrong, say why in one line and leave ` +
    `it — a run that verifies ten and fixes two is a good run.`;

/* The invariants for a turn that CHANGES things. Whatever it does lands as uncommitted work in the owner's
 * workspace, so it is reviewed as one diff by someone who did not watch it happen — which is what every clause
 * here is protecting.
 *
 * "Separately explainable" is doing the most work: a chore that fixes its findings AND tidies what it passed on
 * the way produces a diff whose reviewer cannot tell which changes were the point. */
export const CHORE_INVARIANTS =
    `Keep it mechanical and separately explainable: nothing lands that you could not justify on its own line of the ` +
    `summary. Do not reformat, rename or "while I was in here" anything the finding did not name. Run the repository's ` +
    `own type-check and tests before you finish, and if you cannot make them pass, leave the change out and say so.`;

// The invariants for a turn that only LOOKS. Separate from the above rather than a flag on it, because the failure
// mode is the opposite one: a report-stance chore that quietly starts editing is the single most surprising thing
// this surface could do, and it has to be forbidden in words rather than by omission.
export const REPORT_INVARIANTS =
    `Change nothing. This is a survey: the output is your findings, cited file:line, and a recommendation the owner ` +
    `can act on or dismiss. Where you would propose an edit, describe it and where it would go instead of making it.`;

/* The invariants for a turn refactoring ONE FILE, as the codebase-health panel's rows ask for. Distinct from the
 * chore ones because the blast radius is the thing at stake: named as a radius rather than "only this file",
 * since half those archetypes ask for new files and must not read as forbidding them. */
export const REFACTOR_INVARIANTS =
    `Read it first. Behaviour stays identical, and the blast radius is this file, whatever it splits into, and the ` +
    `importers that must follow — no re-export shims left behind.`;
