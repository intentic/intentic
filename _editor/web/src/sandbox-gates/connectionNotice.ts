import type { ConnectionFailure } from "../composables/sandbox/connection";

/* What the connecting gate SAYS, as a pure function of the classified failure.
 *
 * A first connect must never wear the language of a failure, and a failure must never wear the language of a
 * wait, that distinction used to be carried by "is probeError set", which could only ever produce two
 * shapes. With the cause tagged, each genuinely different situation gets its own words and its own offered
 * action: a sandbox that never announced itself needs setup, one that stopped answering mid-session needs a
 * reconnect, and an expired Google session needs neither, it needs a token, which the shell can mint. */

export interface ConnectionNotice {
    readonly title: string;
    readonly body: string;
    // Which affordance to offer, if any. `undefined` means the wait is ordinary and clears itself, showing a
    // button there invites the user to "fix" something that isn't broken.
    readonly action: "setup" | "signin" | undefined;
}

export const connectionNotice = (failure: ConnectionFailure | undefined, sandboxName: string | undefined): ConnectionNotice => {
    const name = sandboxName ?? `your sandbox`;
    if (failure === undefined) {
        return {
            title: `Connecting to "${name}"…`,
            body: `Your sandbox reported in, opening a live connection to it. Your workspace appears automatically in a moment.`,
            action: undefined,
        };
    }
    switch (failure.kind) {
        case `unaddressed`:
            return {
                title: `Connect "${name}"`,
                body: `This sandbox isn't connected yet, finish setup to start its daemon, and your workspace opens automatically.`,
                action: `setup`,
            };
        case `unauthenticated`:
            return {
                title: `Sign in to reach "${name}"`,
                body: `Your sandbox is up, but the session this browser presents to it has expired. Signing in again reconnects you, nothing on the sandbox is affected.`,
                action: `signin`,
            };
        case `timeout`:
            return {
                title: `Still opening "${name}"…`,
                body: `The sandbox is taking longer than usual to answer. It will open automatically as soon as it is ready.`,
                action: undefined,
            };
        case `closed`:
            return {
                title: `Opening "${name}"…`,
                body: `The sandbox is still getting ready. Retrying automatically.`,
                action: undefined,
            };
        case `forbidden`:
            // The shell routes a 403 to its own "no access" screen before this gate renders; covered here so
            // the union stays total and a routing slip degrades to accurate words rather than a wrong wait.
            return {
                title: `No access to "${name}"`,
                body: `This sandbox refused the Google account you're signed in with. Ask its owner to invite you, or switch accounts.`,
                action: `signin`,
            };
        case `network`:
            return {
                title: `Opening "${name}"…`,
                body: `Waiting for the sandbox to answer. Your workspace opens automatically when it is ready.`,
                action: undefined,
            };
    }
};
