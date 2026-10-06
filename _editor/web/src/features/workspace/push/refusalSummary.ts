import type { CommandRun, PushRun } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

// What a refused push says: the line under its command, naming who refused it in the words that decide what the owner
// can do about it. Everything the push printed stays in the terminal it ran in.

// A predicate following the command (drawn in the same monospace). Empty for a plain failure; the terminal already says
// the rest.
export const outcomeSummary = (run: CommandRun): string => {
    if (run.timedOut === true) {
        return t(`workspace.refusalSummary.timedOut`);
    }
    if (run.status === `error`) {
        return t(`workspace.refusalSummary.couldNotRun`);
    }
    if (run.status === `cancelled`) {
        return t(`workspace.refusalSummary.cancelled`);
    }
    return ``;
};

// A hook's refusal just names the hook (what it printed is in the terminal); remote and transport failures carry git's
// own reason as the advice.
// git's own lines end how they end; the sentence around one must not add a second full stop.
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

const REFUSED_BY: Record<NonNullable<PushRun["refusedBy"]>, (reason: string | undefined) => string> = {
    hook: () => t(`workspace.refusalSummary.hook`),
    remote: (reason) => sentence(t(`workspace.refusalSummary.remote`, { reason: reason ?? t(`workspace.refusalSummary.remoteSaidNo`) })),
    transport: (reason) =>
        sentence(t(`workspace.refusalSummary.transport`, { reason: reason ?? t(`workspace.refusalSummary.transportUnreachable`) })),
};

export const refusalSummary = (run: PushRun): string => {
    if (run.status === `failed` && run.timedOut !== true) {
        return run.refusedBy === undefined ? (run.reason ?? ``) : REFUSED_BY[run.refusedBy](run.reason);
    }
    if (run.status === `error` && run.reason !== undefined) {
        return sentence(t(`workspace.refusalSummary.couldNotRunBecause`, { reason: run.reason }));
    }
    return outcomeSummary(run);
};

// A push the remote turned away for want of a credential, and the git host that did: what connecting that account as a
// capability fixes, so the card can lead there rather than only to the terminal. Undefined for every other refusal,
// and for a host no capability signs in to.
const CREDENTIAL_REFUSAL =
    /Authentication failed|could not read Username|terminal prompts disabled|Invalid username or (?:password|token)|returned error: 40[13]\b/i;

export const credentialHostOf = (run: PushRun): `github` | `gitlab` | undefined => {
    if (run.status !== `failed` || run.refusedBy === `hook`) {
        return undefined;
    }
    const said = `${run.reason ?? ``}\n${run.output}`;
    if (!CREDENTIAL_REFUSAL.test(said)) {
        return undefined;
    }
    if (/github\.com/i.test(said)) {
        return `github`;
    }
    return /gitlab\.com/i.test(said) ? `gitlab` : undefined;
};
