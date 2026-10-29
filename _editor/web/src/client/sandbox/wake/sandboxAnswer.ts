import type { SandboxSummary } from "@intentic/api-contract";

/* WHY ANOTHER SANDBOX IS QUIET, in one place. Every view of the account's other sandboxes (the Changes panel's ledger,
 * the switcher's rows, the agents board, the unreachable telemetry) read only the hosted machine's state, which a
 * sandbox on the owner's own computer does not have, so one its machine had put to sleep was said to be "not answering"
 * in warning ink, beside the ones that really were broken (2026-10-29). Pure, so the table is pinned by a test. */

// - answering: its last read here answered, which outranks anything the list says about it
// - asleep: stopped on purpose for being quiet, and opening it starts it
// - unwakeable: asleep on a computer that is off or offline, so nothing can start it until that computer is back
// - starting: a hosted machine on its way up
// - not-answering: should be up and is not: the one state that is a fault
// - unknown: nothing read yet and nothing said about it
export type SandboxAnswer = `answering` | `asleep` | `unwakeable` | `starting` | `not-answering` | `unknown`;

export interface SandboxSleepWord {
    // Whether opening it starts it now.
    readonly wakeable: boolean;
}

// Whether the platform says it sleeps: a hosted machine's state, or `sleep` on an own-machine row. A platform from before
// `sleep` leaves only the owner's newest host report to read, which says nothing of the machine being up.
export const sleepOfSandbox = (sandbox: SandboxSummary): SandboxSleepWord | undefined => {
    // Read through `??`: a row a test or an older cache built may leave the field out.
    const hosted = sandbox.hosted ?? null;
    if (hosted !== null) {
        return hosted.state === `asleep` ? { wakeable: true } : undefined;
    }
    if (sandbox.sleep !== undefined) {
        return sandbox.sleep === null ? undefined : { wakeable: sandbox.sleep.wakeable };
    }
    return sandbox.hostReport?.asleep === true ? { wakeable: true } : undefined;
};

// `answered` is its last read here: true answered, false failed, undefined none yet.
export const answerOf = (sandbox: SandboxSummary, answered: boolean | undefined): SandboxAnswer => {
    if (answered === true) {
        return `answering`;
    }
    const sleep = sleepOfSandbox(sandbox);
    if (sleep !== undefined) {
        return sleep.wakeable ? `asleep` : `unwakeable`;
    }
    if (answered === undefined) {
        return `unknown`;
    }
    return sandbox.hosted?.state === `starting` ? `starting` : `not-answering`;
};

export const isAsleep = (answer: SandboxAnswer): boolean => answer === `asleep` || answer === `unwakeable`;

// The computer it sleeps on, where this row may name it: the owner's newest host report.
export const sleepingOn = (sandbox: SandboxSummary): string | undefined => sandbox.hostReport?.machine;
