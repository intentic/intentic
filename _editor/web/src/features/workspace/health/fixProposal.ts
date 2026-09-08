import { type CommandRun, commandRunOutcome, type PushRun } from "@intentic/sandbox-contract";

// What a red run says and the prompt it proposes, for the pre-push check and the push itself, kept in one
// module so the two stay in the same wording. The prompt is a suggestion, so it states the situation rather
// than issuing directives. Its output rides in the prompt, fenced to survive markdown, dropped when a killed run leaves
// none.

// The shared skeleton (situation, ask, output) both prompts render into, so the fence, tail heading, and
// order can't drift between them.
const proposal = (situation: string, ask: string, output: string): string => {
    const tail = output.trim();
    return [situation, ask, ...(tail === `` ? [] : [`Its output (tail):\n\n\`\`\`\n${tail}\n\`\`\``])].join(`\n\n`);
};

const ending = (run: CommandRun): string =>
    run.timedOut === true
        ? `did not finish, it hit its time limit and was killed. Treat that as a failure: something hangs, and finding what is part of the fix.`
        : `failed (exit ${run.exitCode ?? `unknown`}).`;

// The ask must say the worktree skips the build step (pnpm hardlinks after a build, EXDEV on this filesystem),
// or the agent fights the filesystem or reports a pass short of the one that failed.
export const checkFixPrompt = (run: CommandRun): string =>
    proposal(
        `\`${run.command}\` ${ending(run)} This is what blocks the push, and it is what CI would have said a few minutes later.`,
        `Find the cause and fix it, then re-run \`${run.command}\` yourself to confirm. You are in a worktree, so that run skips the build step (it cannot run in one) and measures everything else; if the build is what failed, say so rather than reporting a pass it did not cover.`,
        run.output,
    );

/* WHAT A CONTINUED ATTEMPT IS TOLD, as against the opening prompt above: the check ran again and here is its current
 * tail. The conversation already holds the situation and the ask; sending them a second time (which is what a second
 * press used to do) reads to the model as a fresh assignment and to the reader as a transcript that repeats itself.
 * A nudge says only what changed and asks it to carry on. */
export const checkNudgePrompt = (run: CommandRun): string =>
    proposal(
        `\`${run.command}\` ran again and ${ending(run)} The push is still blocked on it.`,
        `Carry on from where you left off: the tail below is the current output, and it is what has to pass. Re-run \`${run.command}\` yourself to confirm.`,
        run.output,
    );

// The hook is the workspace's gate, so its own refusal is the one about the code. Several repos refused in
// one push become sections of one turn; `git push --dry-run` confirms without sending, since git still runs the hook.
export const pushFixPrompt = (runs: readonly PushRun[]): string => {
    const one = (run: PushRun): string =>
        proposal(
            `\`${run.command}\` in ${run.repo} was refused by the repository's own pre-push hook (exit ${run.exitCode ?? `unknown`}). The hook is the workspace's gate, so this is what blocks the push, and it is what CI would have said a few minutes later.`,
            `Find the cause and fix it, then confirm the hook passes: \`git push --dry-run\` in ${run.repo} runs it without sending anything.`,
            run.output,
        );
    return runs.map(one).join(`\n\n---\n\n`);
};

// The continued-attempt counterpart of pushFixPrompt: the hook refused it again, here is what it said this time.
export const pushNudgePrompt = (runs: readonly PushRun[]): string => {
    const one = (run: PushRun): string =>
        proposal(
            `\`${run.command}\` in ${run.repo} was refused by the pre-push hook again (exit ${run.exitCode ?? `unknown`}).`,
            `Carry on from where you left off: the tail below is what the hook said this time. \`git push --dry-run\` in ${run.repo} confirms without sending anything.`,
            run.output,
        );
    return runs.map(one).join(`\n\n---\n\n`);
};

// Identity is the digest's step names only, read from the summary line, never the `✗` lines (which vary per
// test); parentheses are dropped since they vary per push. No digest: keyed by the last line, numbers blanked.
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

// A predicate following the command (drawn in the same monospace) so the sentence reads the same on either
// side of the verdict. Empty for a plain failure; the terminal and proposal below already say the rest.
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

// The equivalent line for a push, which says more since git explains itself. A hook's refusal just names the
// hook (the proposal covers the rest); remote and transport failures carry git's own reason as the advice.
// git's own lines end how they end; the sentence around one must not add a second full stop.
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

// Heading over a settled check: commandRunOutcome's shared wording with the check's own subject.
export const checkOutcome = (run: CommandRun): string => commandRunOutcome(run, `Checks`);
