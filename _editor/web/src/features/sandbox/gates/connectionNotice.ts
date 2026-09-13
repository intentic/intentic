import { DETACHED_AFTER_MS } from "../overview/availability";
import type { ConnectionFailure } from "../live/connection";

// What the connecting gate says, as a pure function of the classified failure and what the platform knows, so setup,
// reconnect, sign-in, removal and blocked causes each get their own words and action instead of one generic screen.
//
// The rule the whole file obeys: a wait is only called a wait while waiting can still repair it. Everything else names
// a cause, and names only causes that were ESTABLISHED — a reported removal, a verdict from the edge, a refused wake.
// Silence establishes nothing, so silence never becomes an accusation; it becomes "this has gone on too long", which is
// true, and a door to the screen that can say more.

// How long a hosted machine gets before the gate stops calling it a wait; comfortably past a healthy ~20s wake.
export const HOSTED_STUCK_AFTER_MS = 60_000;
// The same patience for a sandbox on somebody's own computer. It had none before: no cause on that lane could ever be
// named, so the gate spun until the tab was closed.
export const OWN_STUCK_AFTER_MS = 60_000;
// A detached sandbox's verdict is held for DETACHED_AFTER_MS (availability.ts) before it is spoken: a container that
// restarts is detached for a few seconds, and the gate's words and the switcher's dot change their mind together.

// Which affordance to offer, with its words; one value so a gate can't mix the setup door with sign-in text.
export type ConnectionAction =
    | { readonly kind: "setup"; readonly label: string }
    | { readonly kind: "signin"; readonly label: string }
    // The wake was refused because the free lane's month is spent; the plan lifts it.
    | { readonly kind: "billing"; readonly label: string };

export interface ConnectionNotice {
    readonly title: string;
    readonly body: string;
    // `undefined` means there is nothing for the reader to press; a button would invite fixing what isn't broken.
    readonly action: ConnectionAction | undefined;
    // Whether something is still expected to happen on its own. The spinner reads this and nothing else: a spinner over
    // a sandbox that was deleted is the bug this file exists to end.
    readonly waiting: boolean;
}

export interface ConnectionNoticeInput {
    readonly failure: ConnectionFailure | undefined;
    readonly sandboxName: string | undefined;
    // Whether this sandbox runs on a platform-started machine; only then can the platform be asked to repair it.
    readonly hostedMachine: boolean;
    // How long the current run of failures has lasted (connection.unavailableSince). 0 while nothing has failed.
    readonly outageMs: number;
    // The platform refused the last wake (PAYMENT_REQUIRED) for spent hours; `owner` decides who sees the plan.
    readonly hoursSpent?: boolean;
    readonly owner?: boolean;
    // Set when the machine that deleted this sandbox's container said so (platform `removedAt`/`removedBy`). The one
    // fact no amount of waiting can produce, and the only one that licenses the word "removed".
    readonly removed?: boolean;
    readonly removedBy?: string | null;
}

// The patient wait, in the three shapes the browser can observe; split out since the caller now has a decision to
// make first.
const waitingNotice = (kind: "timeout" | "closed" | "network" | "detached", name: string): ConnectionNotice => {
    if (kind === `timeout`) {
        return {
            title: `Still opening "${name}"…`,
            body: `The sandbox is taking longer than usual to answer. It will open automatically as soon as it is ready.`,
            action: undefined,
            waiting: true,
        };
    }
    if (kind === `closed`) {
        return {
            title: `Opening "${name}"…`,
            body: `The sandbox is still getting ready. Retrying automatically.`,
            action: undefined,
            waiting: true,
        };
    }
    return {
        title: `Opening "${name}"…`,
        body: `Waiting for the sandbox to answer. Your workspace opens automatically when it is ready.`,
        action: undefined,
        waiting: true,
    };
};

// The container was deleted, and the machine that deleted it said so on its way out. Addressed to someone who may not
// have done it themselves, so it says what is gone rather than assuming they know.
const removedNotice = (input: ConnectionNoticeInput, name: string): ConnectionNotice | undefined => {
    if (input.removed !== true) {
        return undefined;
    }
    const where = input.removedBy === undefined || input.removedBy === null || input.removedBy === `` ? `the computer it ran on` : input.removedBy;
    return {
        title: `"${name}" was removed`,
        body: `Its container was deleted on ${where}, and its files went with it. Nothing is on its way back — setting it up again starts this sandbox fresh, under the same name and address.`,
        action: { kind: `setup`, label: `Set it up again` },
        waiting: false,
    };
};

// The platform has no such sandbox: the row is deleted, so no machine can ever serve this address again.
const goneNotice = (name: string): ConnectionNotice => ({
    title: `"${name}" no longer exists`,
    body: `Intentic has no record of this sandbox, so nothing can answer at its address. If you deleted it, this is that; otherwise its owner did. Your other sandboxes are in the switcher above.`,
    action: undefined,
    waiting: false,
});

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
            waiting: false,
        };
    }
    return {
        title: `"${name}" has used its free hours for this month`,
        body: `Free hosted sandboxes get a monthly allowance of awake hours; this one has spent it, so the machine stays asleep until the month resets. The hosted plan keeps it always on. Or move it to your own computer, free, with no hours at all.`,
        action: { kind: `billing`, label: `See the plan` },
        waiting: false,
    };
};

/* THE EDGE'S OWN VERDICT, which is the only thing in this file that can tell a browser's broken network from a sandbox
 * that is simply not there: the request reached Intentic and Intentic held no tunnel for this box. Held for
 * DETACHED_AFTER_MS first, because a container that is restarting is detached for a few seconds and telling someone
 * their sandbox is off during a restart is both true and useless. */
const detachedNotice = (input: ConnectionNoticeInput, name: string): ConnectionNotice | undefined =>
    input.failure?.kind === `detached` && input.outageMs >= DETACHED_AFTER_MS
        ? {
              title: `"${name}" isn't connected`,
              body: `Intentic answered for this address and your sandbox isn't dialled into it, so your own connection is fine. Its container isn't running, or the computer it runs on is off. It opens here by itself the moment it comes back.`,
              action: { kind: `setup`, label: `Check setup` },
              waiting: false,
          }
        : undefined;

// The wait that has stopped being one, on either lane. Nothing is diagnosed: the machine we run can be looked at, and
// the machine somebody else runs is theirs to look at, which is exactly what each sentence says.
const stuckNotice = (input: ConnectionNoticeInput, name: string): ConnectionNotice | undefined => {
    if (input.hostedMachine) {
        return input.outageMs >= HOSTED_STUCK_AFTER_MS
            ? {
                  title: `"${name}" isn't answering`,
                  body: `The machine we run this sandbox on hasn't come back. Nothing on your side causes this — open its setup screen to see what the machine is doing and start it over.`,
                  action: { kind: `setup`, label: `Check the machine` },
                  waiting: false,
              }
            : undefined;
    }
    return input.outageMs >= OWN_STUCK_AFTER_MS
        ? {
              title: `"${name}" isn't answering`,
              body: `It has been silent for a while. This sandbox runs on a computer of your own: check that computer is awake and its container is running. The workspace opens here by itself as soon as it answers.`,
              action: { kind: `setup`, label: `Check setup` },
              waiting: false,
          }
        : undefined;
};

// The network-shaped causes read as one thing (a wait) while waiting can still fix them, then as the most specific
// thing established about them. A refused wake outranks everything, at any age.
const networkNotice = (input: ConnectionNoticeInput, kind: "timeout" | "closed" | "network" | "detached", name: string): ConnectionNotice =>
    hoursSpentNotice(input, name) ?? detachedNotice(input, name) ?? stuckNotice(input, name) ?? waitingNotice(kind, name);

// The causes that are one fixed sentence whatever else is true, as a table — so the function below holds only the
// decisions that need one, and a new cause cannot be added without giving it words.
type SettledKind = "gone" | "unaddressed" | "unauthenticated" | "forbidden";

const SETTLED: Record<SettledKind, (name: string) => ConnectionNotice> = {
    gone: goneNotice,
    unaddressed: (name) => ({
        title: `Connect "${name}"`,
        body: `This sandbox isn't connected yet, finish setup to start its daemon, and your workspace opens automatically.`,
        action: { kind: `setup`, label: `Finish setup` },
        waiting: false,
    }),
    unauthenticated: (name) => ({
        title: `Sign in to reach "${name}"`,
        body: `Your sandbox is up, but the session this browser presents to it has expired. Signing in again reconnects you, nothing on the sandbox is affected.`,
        action: { kind: `signin`, label: `Sign in again` },
        waiting: false,
    }),
    // A routed 403 goes elsewhere; kept here so a routing slip still shows accurate words.
    forbidden: (name) => ({
        title: `No access to "${name}"`,
        body: `This sandbox refused the Google account you're signed in with. Ask its owner to invite you, or switch accounts.`,
        action: { kind: `signin`, label: `Sign in again` },
        waiting: false,
    }),
};

const isSettled = (kind: ConnectionFailure[`kind`]): kind is SettledKind => kind in SETTLED;

export const connectionNotice = (input: ConnectionNoticeInput): ConnectionNotice => {
    const { failure } = input;
    const name = input.sandboxName ?? `your sandbox`;
    if (failure === undefined) {
        return {
            title: `Connecting to "${name}"…`,
            body: `Your sandbox reported in, opening a live connection to it. Your workspace appears automatically in a moment.`,
            action: undefined,
            waiting: true,
        };
    }
    // Ahead of every arm below, including `unaddressed`: a removed sandbox has no address precisely BECAUSE it was
    // removed, and "finish setup" is a thinner answer than the one we have.
    const removed = removedNotice(input, name);
    if (removed !== undefined) {
        return removed;
    }
    return isSettled(failure.kind) ? SETTLED[failure.kind](name) : networkNotice(input, failure.kind, name);
};
