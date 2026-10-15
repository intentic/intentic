import { ScopeError } from "./policy.js";

/* THIS PROCESS MAY HAVE NO DESKTOP (2026-10-15). On Windows the agent can be started by the machine itself, before anyone
   signs in (`intentic-machine before-sign-in on`, local-agent's beforeSignIn): a process with no session, so no screen,
   no windows, no clipboard and no browser to show. Commands, files and sandboxes need none of that and work as they do
   after a sign-in. Everything that needs a desktop is refused in one sentence instead of failing on whatever the
   capture library meets first, and the agent of the signed-in session takes over at the next sign-in
   (resident/resident.ts), which is when these tools come back. */

let beforeSignIn = false;

// Said once, by the resident, as it starts in that mode.
export const startedBeforeSignIn = (): void => {
    beforeSignIn = true;
};

export const runningBeforeSignIn = (): boolean => beforeSignIn;

export const NO_DESKTOP_YET =
    "Nobody has signed in on this PC since it started, so there is no screen here for this agent to see or drive yet. Commands, files and sandboxes work now; the screen, window, clipboard and browser tools come back once someone signs in.";

// A refusal, not a failure: nothing is wrong with the call, the PC is waiting for a person.
export const assertDesktop = (): void => {
    if (beforeSignIn) {
        throw new ScopeError(NO_DESKTOP_YET);
    }
};
