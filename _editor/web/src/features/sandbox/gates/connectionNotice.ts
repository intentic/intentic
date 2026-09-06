import type { ConnectionFailure } from "../live/connection";

/* What the connecting gate SAYS, as a pure function of the classified failure.
 *
 * A first connect must never wear the language of a failure, and a failure must never wear the language of a
 * wait, that distinction used to be carried by "is probeError set", which could only ever produce two
 * shapes. With the cause tagged, each genuinely different situation gets its own words and its own offered
 * action: a sandbox that never announced itself needs setup, one that stopped answering mid-session needs a
 * reconnect, and an expired Google session needs neither, it needs a token, which the shell can mint.
 *
 * AND A WAIT THAT IS NOT GOING TO END NEEDS A DOOR. Every network-shaped cause below is answered by "opening…"
 * and a spinner, on the reasoning that transport failures repair themselves and a button would invite the
 * reader to fix what is not broken. That reasoning holds for a daemon that is restarting and fails completely
 * for a MACHINE THE PLATFORM RUNS that is not coming back: the sandbox's own hardware boots and dies, or its
 * hour budget ran out, or its image is broken — and the browser's wake reflex fires into it forever while the
 * gate says "Waiting for the sandbox to answer" in perpetuity. That is the screen this product was reported
 * for: a workspace, opened, spinning, with nothing on it to press. The platform knows what is wrong with a
 * hosted machine and the setup screen already narrates it in full (hostedWait.ts) with the repair underneath,
 * so past a point this gate stops narrating a wait and points at that. */

// How long a hosted machine gets to answer before the gate stops calling it a wait. A stopped machine that the
// wake reflex has just started is up inside ~20s, so this is comfortably past a healthy wake and comfortably
// short of the several minutes people were sitting through.
export const HOSTED_STUCK_AFTER_MS = 60_000;

// Which affordance to offer, with the words it wears. One value rather than a `kind` beside a `label`, so a
// gate can never draw the setup door under the sign-in sentence.
export type ConnectionAction =
    | { readonly kind: "setup"; readonly label: string }
    | { readonly kind: "signin"; readonly label: string }
    // The Billing page: the wake was refused because the free lane's month is spent, and the plan lifts it.
    | { readonly kind: "billing"; readonly label: string };

export interface ConnectionNotice {
    readonly title: string;
    readonly body: string;
    // `undefined` means the wait is ordinary and clears itself, showing a button there invites the user to
    // "fix" something that isn't broken.
    readonly action: ConnectionAction | undefined;
}

export interface ConnectionNoticeInput {
    readonly failure: ConnectionFailure | undefined;
    readonly sandboxName: string | undefined;
    /* This sandbox runs on a machine THE PLATFORM started (the row's `hosted`). The only case where a daemon
     * that simply will not answer has a named cause and a repair the reader can reach, because the platform
     * owns the box: it can say what state it is in and it can build a new one. A sandbox on somebody's own
     * computer gets the patient wait it has always had — nothing here can tell a closed laptop from a slow
     * Docker pull, and inventing an alarm for it would be guessing. */
    readonly hostedMachine: boolean;
    // How long the current run of failures has lasted (connection.unavailableSince). 0 while nothing has failed.
    readonly outageMs: number;
    /* The platform REFUSED the last wake for spent hours (useSandbox's wake reflex, PAYMENT_REQUIRED). The one
     * network-shaped outage with a named cause and a price on the remedy: the machine is asleep and will stay
     * so until the month resets or the plan is bought. `owner` decides who is offered the plan: a guest on a
     * shared sandbox cannot buy the owner's, and a Subscribe button for them would sell the wrong person. */
    readonly hoursSpent?: boolean;
    readonly owner?: boolean;
}

/* The patient wait, in the three shapes the browser can actually observe. Its own function because the arm it
 * belongs to now has a decision in front of it (is this a wait at all?), and one `switch` holding both the
 * decision and the three sets of words is a function nobody can read the shape of. */
const waitingNotice = (kind: "timeout" | "closed" | "network", name: string): ConnectionNotice => {
    if (kind === `timeout`) {
        return {
            title: `Still opening "${name}"…`,
            body: `The sandbox is taking longer than usual to answer. It will open automatically as soon as it is ready.`,
            action: undefined,
        };
    }
    if (kind === `closed`) {
        return { title: `Opening "${name}"…`, body: `The sandbox is still getting ready. Retrying automatically.`, action: undefined };
    }
    return {
        title: `Opening "${name}"…`,
        body: `Waiting for the sandbox to answer. Your workspace opens automatically when it is ready.`,
        action: undefined,
    };
};

/* THE MONTH IS SPENT. Not a wait at all, and said before any wait: the platform declined to start the machine,
 * the meter (Billing, the avatar row) has read zero for a while, and the two ways out are the plan and a
 * computer of the reader's own. Addressed to whoever is reading: the owner is offered the plan, a guest is told
 * whose hours they are and offered nothing to buy. */
const hoursSpentNotice = (input: ConnectionNoticeInput, name: string): ConnectionNotice | undefined => {
    if (!input.hostedMachine || input.hoursSpent !== true) {
        return undefined;
    }
    if (input.owner === false) {
        return {
            title: `"${name}" has used its free hours for this month`,
            body: `The owner's free hosted hours are spent, so the machine stays asleep until the month resets or the owner moves it to the hosted plan. Nothing on your side causes this.`,
            action: undefined,
        };
    }
    return {
        title: `"${name}" has used its free hours for this month`,
        body: `Free hosted sandboxes get a monthly allowance of awake hours; this one has spent it, so the machine stays asleep until the month resets. The hosted plan keeps it always on. Or move it to your own computer, free, with no hours at all.`,
        action: { kind: `billing`, label: `See the plan` },
    };
};

/* …and the wait that has stopped being one. Undefined whenever this is still an ordinary outage — a sandbox on
 * the reader's own computer (nothing here can tell a closed laptop from a slow pull), or one of ours that has
 * not yet had its minute. */
const stuckHostedNotice = (input: ConnectionNoticeInput, name: string): ConnectionNotice | undefined =>
    input.hostedMachine && input.outageMs >= HOSTED_STUCK_AFTER_MS
        ? {
              title: `"${name}" isn't answering`,
              body: `The machine we run this sandbox on hasn't come back. Nothing on your side causes this — open its setup screen to see what the machine is doing and start it over.`,
              action: { kind: `setup`, label: `Check the machine` },
          }
        : undefined;

/* The three network-shaped causes. They differ only in what the browser observed, and for the first minute they
 * are all the same thing to a reader — a wait — so they keep their own words and no button. Past that, on a
 * machine we run, they are all the same thing again: it is not coming back on its own, and the screen that can
 * say why is one click away. A wake the platform REFUSED outranks both: that is not a wait at any age. */
const networkNotice = (input: ConnectionNoticeInput, kind: "timeout" | "closed" | "network", name: string): ConnectionNotice =>
    hoursSpentNotice(input, name) ?? stuckHostedNotice(input, name) ?? waitingNotice(kind, name);

export const connectionNotice = (input: ConnectionNoticeInput): ConnectionNotice => {
    const { failure } = input;
    const name = input.sandboxName ?? `your sandbox`;
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
                action: { kind: `setup`, label: `Finish setup` },
            };
        case `unauthenticated`:
            return {
                title: `Sign in to reach "${name}"`,
                body: `Your sandbox is up, but the session this browser presents to it has expired. Signing in again reconnects you, nothing on the sandbox is affected.`,
                action: { kind: `signin`, label: `Sign in again` },
            };
        case `forbidden`:
            // The shell routes a 403 to its own "no access" screen before this gate renders; covered here so
            // the union stays total and a routing slip degrades to accurate words rather than a wrong wait.
            return {
                title: `No access to "${name}"`,
                body: `This sandbox refused the Google account you're signed in with. Ask its owner to invite you, or switch accounts.`,
                action: { kind: `signin`, label: `Sign in again` },
            };
        case `timeout`:
        case `closed`:
        case `network`:
            return networkNotice(input, failure.kind, name);
    }
};
