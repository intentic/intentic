import type { CommandRun, PushRun } from "@intentic/sandbox-contract";

// What a refused push says: the line under its command, naming who refused it in the words that decide what the owner
// can do about it. Everything the push printed stays in the terminal it ran in.

// A predicate following the command (drawn in the same monospace). Empty for a plain failure; the terminal already says
// the rest.
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

// A hook's refusal just names the hook (what it printed is in the terminal); remote and transport failures carry git's
// own reason as the advice.
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
