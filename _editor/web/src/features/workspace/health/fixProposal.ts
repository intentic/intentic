import { type CommandRun, commandRunOutcome, type PushRun } from "@intentic/sandbox-contract";

/* WHAT A RED RUN SAYS, AND THE PROMPT IT PROPOSES, for both halves of the push flow: the pre-push check
 * (CommandRun) and the push itself (PushRun). One module rather than one per run, because the two are the same
 * situation, a command the owner started said no and the app has its tail, and two copies of "how to turn
 * that into a sentence and a turn" had already drifted on their first field.
 *
 * THE PROMPT IS A SUGGESTION, not a command: it lands in an editable composer (SuggestedSessionBox) and the
 * user can rewrite any of it before it goes. That is why it states the situation plainly rather than issuing a
 * list of rules, a prompt written as an unarguable directive reads badly the moment a human edits half of it.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. The old landing-gate prompt pinned the turn to the main working tree and
 * forbade it to commit, because it was repairing UNCOMMITTED landed work that only existed there. A refused
 * push is the opposite situation: the work is committed, on a branch, and the agent gets an isolated worktree
 * of its own, so the ordinary agent flow (fix, then land the diff for review) applies with nothing special said
 * about it, and saying it anyway would contradict the worktree the turn is actually running in.
 *
 * THE OUTPUT RIDES IN THE PROMPT rather than being left for the agent to reproduce: re-running the suite is
 * minutes the agent spends to learn what is already on screen, and the tail is where a runner puts the failure
 * summary. It is quoted in a fence because a stack trace full of backticks and hashes otherwise arrives as
 * mangled markdown. A run that was KILLED has none, what a signalled command had buffered is not a verdict, and
 * the whole of it is in the terminal it ran in, so the paragraph is dropped rather than fenced around nothing. */

// The one skeleton: what happened, what to do, what it printed. Both prompts are this with different words in
// the first two slots, so the fence, the tail's heading and the order cannot differ between them.
const proposal = (situation: string, ask: string, output: string): string => {
    const tail = output.trim();
    return [situation, ask, ...(tail === `` ? [] : [`Its output (tail):\n\n\`\`\`\n${tail}\n\`\`\``])].join(`\n\n`);
};

const ending = (run: CommandRun): string =>
    run.timedOut === true
        ? `did not finish, it hit its time limit and was killed. Treat that as a failure: something hangs, and finding what is part of the fix.`
        : `failed (exit ${run.exitCode ?? `unknown`}).`;

/* WHAT THE AGENT CAN ACTUALLY RE-RUN, said in the ask, because the agent is not standing where the check ran.
 * The proposal is isolated, so the turn gets a linked worktree, and `pnpm build` cannot run in one at all —
 * pnpm hardlinks into node_modules after a build and the worktree's is a different filesystem, so the run dies
 * EXDEV. The push gate knows this and drops the build step there rather than failing (verify-push.mjs), which
 * means the confirmation an agent can give is real but is a step short of the one that refused the push. An
 * ask that did not say so is an ask for a confirmation that cannot be produced, and the turn spends itself
 * either fighting the filesystem or reporting a pass the owner's tree will not repeat. */
export const checkFixPrompt = (run: CommandRun): string =>
    proposal(
        `\`${run.command}\` ${ending(run)} This is what blocks the push, and it is what CI would have said a few minutes later.`,
        `Find the cause and fix it, then re-run \`${run.command}\` yourself to confirm. You are in a worktree, so that run skips the build step (it cannot run in one) and measures everything else; if the build is what failed, say so rather than reporting a pass it did not cover.`,
        run.output,
    );

/* A push the repository's own pre-push hook refused, which is the one refusal that is about the code: the hook
 * is the workspace's gate, and what it printed is the suite's verdict. Several repos refused in one push are
 * several sections of one turn, the agent works one worktree and can reach all of them. `git push --dry-run`
 * is how the agent confirms without sending: git runs the pre-push hook for a dry run too. */
export const pushFixPrompt = (runs: readonly PushRun[]): string => {
    const one = (run: PushRun): string =>
        proposal(
            `\`${run.command}\` in ${run.repo} was refused by the repository's own pre-push hook (exit ${run.exitCode ?? `unknown`}). The hook is the workspace's gate, so this is what blocks the push, and it is what CI would have said a few minutes later.`,
            `Find the cause and fix it, then confirm the hook passes: \`git push --dry-run\` in ${run.repo} runs it without sending anything.`,
            run.output,
        );
    return runs.map(one).join(`\n\n---\n\n`);
};

/* WHAT MAKES TWO RED RUNS THE SAME FAILURE, so that pressing "fix this" twice reaches one agent instead of two
 * (conversation-ids.ts's `pushFixConversationId` is the other half).
 *
 * The gates print a digest LAST, on purpose and for a reader exactly like this one (_tools/scripts/lib/steps.mjs):
 * `verify-push: 2 of 6 steps failed in 12s: checkout gates, lint`. That list of STEP NAMES is the identity of a
 * failure. Not the exit codes, not the durations, not the line numbers — all of which move between two runs of
 * the same broken tree — and not the output either, since a typecheck error quotes a path that changes the
 * moment anything above it is edited.
 *
 * READ FROM THE SUMMARY LINE, never from the `✗` lines under it, even though those name the same steps: a
 * suite's own output is full of `✗` (every failing vitest case prints one) and a signature that swept those up
 * would change with the name of any test. The summary line has a shape nothing else in the stream has.
 *
 * PARENTHESES ARE DROPPED because that is where the digest puts what varies: `assertion ratchet
 * (a1b2c3d..e4f5g6h)` is the same gate on every push and would otherwise be a new agent on every push.
 *
 * A RUN WITH NO DIGEST ended where it stood rather than collecting — an unmeasurable range, a suite that could
 * not start, a verdict replayed (verify-push.mjs's `refuse`). There the last line is the reason, taken with its
 * numbers blanked, so that "failed (exit 1)" and "failed (exit 2)" are not two different failures. */
const DIGEST = /^\s*\S+: \d+ of \d+ steps failed in \d+s: (.+)$/m;
export const fixSignature = (output: string): string => {
    const listed = DIGEST.exec(output)?.[1];
    if (listed !== undefined) {
        const steps = listed
            .split(`,`)
            .map((label) => label.replace(/\s*\([^)]*\)/g, ``).trim())
            .filter((label) => label !== ``);
        if (steps.length > 0) {
            return [...new Set(steps)].sort((left, right) => left.localeCompare(right)).join(`,`);
        }
    }
    const lines = output
        .split(`\n`)
        .map((line) => line.trim())
        .filter((line) => line !== ``);
    return (lines.at(-1) ?? ``).replace(/\d+/g, `#`);
};

/* The one line under the command on the card: what happened, without the evidence under it repeating itself.
 * It is a PREDICATE, the command itself is drawn in front of it, in the same monospace it wears while the run
 * is still going, so the sentence reads the same either side of the verdict. (Wrapping the command in backticks
 * here was the markdown of the prompts leaking into a plain-text line, which rendered them as the literal
 * characters.) Empty for a plain failure: the terminal and the proposal under it say the rest. */
export const outcomeSummary = (run: CommandRun): string => {
    if (run.timedOut === true) {
        return `never finished: it hit its time limit and was killed.`;
    }
    if (run.status === `error`) {
        return `could not run at all.`;
    }
    if (run.status === `cancelled`) {
        return `was stopped before it finished.`;
    }
    return ``;
};

/* The same line for a push, which has more to say than a check does because git said it: who refused it, in
 * the words that decide what the owner can do about it. A hook's refusal is answered by the proposal under the
 * line (and the terminal), so it names the hook and stops; the other two carry git's own reason, which is the
 * whole of the advice. */
// git's own lines end how they end (`fatal: Could not read from remote repository.`); the sentence around one
// must not add a second full stop to it.
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

const REFUSED_BY: Record<NonNullable<PushRun["refusedBy"]>, (reason: string | undefined) => string> = {
    hook: () => `was refused by this repository's pre-push hook.`,
    remote: (reason) => sentence(`was rejected by the remote: ${reason ?? `it said no`}`),
    transport: (reason) => sentence(`never reached the remote: ${reason ?? `it could not be contacted`}`),
};

export const refusalSummary = (run: PushRun): string => {
    if (run.status === `failed` && run.timedOut !== true) {
        return run.refusedBy === undefined ? (run.reason ?? ``) : REFUSED_BY[run.refusedBy](run.reason);
    }
    if (run.status === `error` && run.reason !== undefined) {
        return sentence(`could not run: ${run.reason}`);
    }
    return outcomeSummary(run);
};

// The heading over a settled check, the shared wording (commandRunOutcome) with the check's own subject.
export const checkOutcome = (run: CommandRun): string => commandRunOutcome(run, `Checks`);
