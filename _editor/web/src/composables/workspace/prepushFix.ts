import type { PrepushRun } from "@intentic/sandbox-contract";

/* THE PROMPT A FAILED PRE-PUSH CHECK PROPOSES, everything the fix turn needs so it does not have to
 * rediscover it: what ran, how it ended, and what it printed.
 *
 * It is a SUGGESTION, not a command: it lands in an editable composer (SuggestedSessionBox) and the user can
 * rewrite any of it before it goes. That is why it states the situation plainly rather than issuing a list of
 * rules, a prompt written as an unarguable directive reads badly the moment a human edits half of it.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. The old landing-gate prompt pinned the turn to the main working tree and
 * forbade it to commit, because it was repairing UNCOMMITTED landed work that only existed there. A pre-push
 * failure is the opposite situation: the work is committed, on a branch, and the agent gets an isolated
 * worktree of its own, so the ordinary agent flow (fix, then land the diff for review) applies with nothing
 * special said about it, and saying it anyway would contradict the worktree the turn is actually running in.
 *
 * The output rides in the prompt rather than being left for the agent to reproduce: re-running the suite is
 * minutes the agent spends to learn what is already on screen, and the tail is where a runner puts the failure
 * summary. It is quoted in a fence because a stack trace full of backticks and hashes otherwise arrives as
 * mangled markdown. A run that was KILLED has none, what a signalled command had buffered is not a verdict, and
 * the whole of it is in the terminal it ran in, so the paragraph is dropped rather than fenced around nothing. */
export const fixPrompt = (run: PrepushRun): string => {
    const ending =
        run.timedOut === true
            ? `did not finish — it hit its time limit and was killed. Treat that as a failure: something hangs, and finding what is part of the fix.`
            : `failed (exit ${run.exitCode ?? `unknown`}).`;
    const output = run.output.trim();
    return [
        `\`${run.command}\` ${ending} This is what blocks the push, and it is what CI would have said a few minutes later.`,
        `Find the cause and fix it, then re-run \`${run.command}\` yourself to confirm.`,
        ...(output === `` ? [] : [`Its output (tail):\n\n\`\`\`\n${output}\n\`\`\``]),
    ].join(`\n\n`);
};

/* The one line above the composer: what happened, without the evidence under it repeating itself. It is a
 * PREDICATE, the command itself is drawn in front of it, in the same monospace it wears while the check is still
 * going, so the sentence reads the same either side of the verdict. (Wrapping the command in backticks here was
 * the markdown of `fixPrompt` leaking into a plain-text line, which rendered them as the literal characters.) */
export const fixSummary = (run: PrepushRun): string => {
    if (run.timedOut === true) {
        return `never finished — it hit its time limit and was killed.`;
    }
    if (run.status === `error`) {
        return `could not run at all.`;
    }
    if (run.status === `cancelled`) {
        return `was stopped before it finished.`;
    }
    return `failed with exit ${run.exitCode ?? `unknown`}.`;
};

/* The heading over a settled check, three or four words, because it is read at a glance and from across a
 * view the user may have walked back into. `passed` never appears: that outcome sends the push and says so in
 * the panel, so every case left here is a reason the user is still being asked something. */
export const checkOutcome = (run: PrepushRun): string => {
    if (run.timedOut === true) {
        return `Checks timed out`;
    }
    switch (run.status) {
        case `error`:
            return `Checks couldn't run`;
        case `cancelled`:
            return `Checks stopped`;
        case `failed`:
            return `Checks failed`;
        default:
            // `idle` reaches here only when the command was cleared between the click and the request, there is
            // no check any more, so it says so rather than implying one ran and said nothing.
            return `Checks didn't run`;
    }
};
