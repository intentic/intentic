import type { SandboxSummary } from "@intentic/api-contract";
import type { SandboxReach } from "@intentic/sandbox-contract/schemas/sandbox-reach";
import { SandboxTimeoutError } from "../../../client/sandbox/sandboxAuthFetch";
import { daemonErrorStatus } from "../../../client/sandbox/sandboxRpc";
import { sleepOfSandbox } from "../../../client/sandbox/wake/sandboxAnswer";
import type { ReadState } from "./accountGraph";

// HOW ONE SANDBOX'S READ STANDS, from the platform's row and the read's own outcome: what the access map says on its card
// and whether its last answer is drawn as current. Apart from the composable that makes the reads (useAccountReach.ts)
// so the rule is tested by itself.

// A sandbox that cannot answer now without being woken or without a machine that is off: its last answer stands.
export const stillOf = (sandbox: SandboxSummary): ReadState | undefined => {
    if (sandbox.daemonUrl === null || sandbox.daemonUrl === ``) {
        return `unreachable`;
    }
    if (sleepOfSandbox(sandbox) !== undefined) {
        return `asleep`;
    }
    const hosted = sandbox.hosted?.state;
    return hosted === `starting` ? `asleep` : hosted === `down` ? `unreachable` : undefined;
};

// Why a read failed, in the words the map says it: a daemon from before the route, a person it no longer lets read, no
// session to read it under, or no answer at all.
export const failureOf = (error: Error): ReadState => {
    const status = daemonErrorStatus(error);
    if (status === 404) {
        return `old`;
    }
    if (status === 403) {
        return `locked`;
    }
    if (status === 401 || status === 428) {
        return `signin`;
    }
    if (status !== undefined || error instanceof SandboxTimeoutError || error instanceof TypeError) {
        return `unreachable`;
    }
    // No status and no network failure: the background read found no session it could use without asking.
    return `signin`;
};

/** What a read's outcome comes to: a sandbox that cannot be asked now says why first, then a read under way, a failure, an answer. */
export const readStateOf = (
    sandbox: SandboxSummary,
    read: { readonly fetching: boolean; readonly error: Error | null; readonly answer: SandboxReach | undefined },
): ReadState => {
    const still = stillOf(sandbox);
    if (still !== undefined) {
        return still;
    }
    if (read.fetching) {
        return `reading`;
    }
    if (read.error !== null) {
        return failureOf(read.error);
    }
    return read.answer === undefined ? `reading` : `fresh`;
};
