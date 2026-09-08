import type { ConnectionFailure } from "../live/connection";

// What the connecting gate says, as a pure function of the classified failure, so setup, reconnect, sign-in and
// blocked causes each get their own words and action instead of one generic screen. Network causes get
// 'opening…' and a spinner; past HOSTED_STUCK_AFTER_MS on a platform-run machine, it points at setup instead.

// How long a hosted machine gets before the gate stops calling it a wait; comfortably past a healthy ~20s wake.
export const HOSTED_STUCK_AFTER_MS = 60_000;

// Which affordance to offer, with its words; one value so a gate can't mix the setup door with sign-in text.
export type ConnectionAction =
    | { readonly kind: "setup"; readonly label: string }
    | { readonly kind: "signin"; readonly label: string }
    // The wake was refused because the free lane's month is spent; the plan lifts it.
    | { readonly kind: "billing"; readonly label: string };

export interface ConnectionNotice {
    readonly title: string;
    readonly body: string;
    // `undefined` means the wait is ordinary and self-clearing; a button would invite fixing what isn't broken.
    readonly action: ConnectionAction | undefined;
}

export interface ConnectionNoticeInput {
    readonly failure: ConnectionFailure | undefined;
    readonly sandboxName: string | undefined;
    // Whether this sandbox runs on a platform-started machine; only then can a cause be named and repaired.
    readonly hostedMachine: boolean;
    // How long the current run of failures has lasted (connection.unavailableSince). 0 while nothing has failed.
    readonly outageMs: number;
    // The platform refused the last wake (PAYMENT_REQUIRED) for spent hours; `owner` decides who sees the plan.
    readonly hoursSpent?: boolean;
    readonly owner?: boolean;
}

// The patient wait, in the three shapes the browser can observe; split out since the caller now has a decision to
// make first.
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

// Not a wait at all: the platform declined to start the machine, and the meter has read zero for a while.
// Addressed to whoever is reading: the owner is offered the plan; a guest is told whose hours they are.
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

// The wait that has stopped being one; undefined for a sandbox on the reader's own computer, or one that hasn't
// yet had its minute.
const stuckHostedNotice = (input: ConnectionNoticeInput, name: string): ConnectionNotice | undefined =>
    input.hostedMachine && input.outageMs >= HOSTED_STUCK_AFTER_MS
        ? {
              title: `"${name}" isn't answering`,
              body: `The machine we run this sandbox on hasn't come back. Nothing on your side causes this — open its setup screen to see what the machine is doing and start it over.`,
              action: { kind: `setup`, label: `Check the machine` },
          }
        : undefined;

// The three network-shaped causes read as one thing (a wait) for the first minute, then as one thing again past it
// on a machine we run: not coming back. A refused wake outranks both, at any age.
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
            // A routed 403 goes elsewhere; kept here so a routing slip still shows accurate words.
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
