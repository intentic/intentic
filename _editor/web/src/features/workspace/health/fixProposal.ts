import type { CommandRun, PushRun } from "@intentic/sandbox-contract";

// What a refused push says and the fix it proposes. The prompt is a suggestion, so it states the situation rather than
// issuing directives; its output rides fenced to survive markdown, dropped when a killed run leaves none.

// The skeleton (situation, ask, output) the opening prompt and the nudge share.
const proposal = (situation: string, ask: string, output: string): string => {
    const tail = output.trim();
    return [situation, ask, ...(tail === `` ? [] : [`Its output (tail):\n\n\`\`\`\n${tail}\n\`\`\``])].join(`\n\n`);
};

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

// Identity is the failed steps (parentheses dropped) plus every path the output names; no digest: the last line, numbers blanked.
const DIGEST = /^\s*\S+: \d+ of \d+ steps failed in \d+s: (.+)$/m;
const NAMED_PATH = /(?:^|[\s(])((?:[\w@.-]+\/)+[\w@.-]+)/g;
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort((left, right) => left.localeCompare(right));
export const fixSignature = (output: string): string => {
    const listed = DIGEST.exec(output)?.[1];
    if (listed !== undefined) {
        const steps = listed
            .split(`,`)
            .map((label) => label.replace(/\s*\([^)]*\)/g, ``).trim())
            .filter((label) => label !== ``);
        if (steps.length > 0) {
            const paths = sorted([...output.matchAll(NAMED_PATH)].map((found) => found[1]!.replace(/[.,;:]+$/, ``)));
            return [sorted(steps).join(`,`), ...(paths.length > 0 ? [paths.join(`,`)] : [])].join(`|`);
        }
    }
    const lines = output
        .split(`\n`)
        .map((line) => line.trim())
        .filter((line) => line !== ``);
    return (lines.at(-1) ?? ``).replace(/\d+/g, `#`);
};

// A predicate following the command (drawn in the same monospace). Empty for a plain failure; the terminal and proposal
// already say the rest.
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

// A hook's refusal just names the hook (the proposal covers the rest); remote and transport failures carry git's own
// reason as the advice.
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
