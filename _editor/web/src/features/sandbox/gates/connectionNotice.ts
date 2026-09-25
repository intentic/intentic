import { DETACHED_AFTER_MS } from "../overview/availability";
import type { ConnectionFailure } from "../live/connection";
import { RESTART_PATIENCE_MS, type RestartQuiet } from "../live/sandboxRestart";
import { t } from "@intentic/ui/i18n";

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
    // The wake was refused because the free plan's month is spent; the plan lifts it.
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
    // The platform refused the last wake (FORBIDDEN) because the owner's hosted lane is switched off.
    readonly suspended?: boolean;
    readonly owner?: boolean;
    // Set when the machine that deleted this sandbox's container said so (platform `removedAt`/`removedBy`). The one
    // fact no amount of waiting can produce, and the only one that licenses the word "removed".
    readonly removed?: boolean;
    readonly removedBy?: string | null;
    // A restart this browser asked for (sandboxRestart.ts), still young enough to be what the silence is. The only
    // input here that explains a wait instead of ending one.
    readonly restart?: RestartQuiet | undefined;
    // A daemon path this browser watched run out its own deadline (perf.ts `stalledPaths`). Observed, not inferred:
    // the one cause here that a silent machine cannot account for, because something did answer long enough to be timed.
    readonly stalledPath?: string | undefined;
}

// The patient wait, in the three shapes the browser can observe; split out since the caller now has a decision to
// make first.
const waitingNotice = (kind: "timeout" | "closed" | "network" | "detached", name: string): ConnectionNotice => {
    if (kind === `timeout`) {
        return {
            title: t(`sandbox.connectionNotice.stillOpening`, { name }),
            body: t(`sandbox.connectionNotice.sandboxTakingLongerThan`),
            action: undefined,
            waiting: true,
        };
    }
    if (kind === `closed`) {
        return {
            title: t(`sandbox.connectionNotice.opening`, { name }),
            body: t(`sandbox.connectionNotice.sandboxStillGettingReady`),
            action: undefined,
            waiting: true,
        };
    }
    return {
        title: t(`sandbox.connectionNotice.opening`, { name }),
        body: t(`sandbox.connectionNotice.waitingSandboxToAnswer`),
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
        title: t(`sandbox.connectionNotice.removed`, { name }),
        body: t(`sandbox.connectionNotice.containerDeletedOnFiles`, { where }),
        action: { kind: `setup`, label: t(`sandbox.connectionNotice.setUpAgain`) },
        waiting: false,
    };
};

// The platform has no such sandbox: the row is deleted, so no machine can ever serve this address again.
const goneNotice = (name: string): ConnectionNotice => ({
    title: t(`sandbox.connectionNotice.noLongerExists`, { name }),
    body: t(`sandbox.connectionNotice.intenticNoRecordSandbox`),
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
            title: t(`sandbox.connectionNotice.usedFreeHoursMonth`, { name }),
            body: t(`sandbox.connectionNotice.ownersFreeHostedHours`),
            action: undefined,
            waiting: false,
        };
    }
    return {
        title: t(`sandbox.connectionNotice.usedFreeHoursMonth`, { name }),
        body: t(`sandbox.connectionNotice.freeHostedSandboxesGet`),
        action: { kind: `billing`, label: t(`sandbox.connectionNotice.seePlan`) },
        waiting: false,
    };
};

// The platform will not start this machine for anybody: the owner's hosted lane is switched off (an acceptable-use
// verdict, the platform's or an operator's). Nothing to press: the way back is the email the owner was sent, and the
// reader's own computer, which the lane never covered.
const suspendedNotice = (input: ConnectionNoticeInput, name: string): ConnectionNotice | undefined => {
    if (!input.hostedMachine || input.suspended !== true) {
        return undefined;
    }
    if (input.owner === false) {
        return {
            title: t(`sandbox.connectionNotice.cantStartedRightNow`, { name }),
            body: t(`sandbox.connectionNotice.hostedSandboxesSwitchedOff2`),
            action: undefined,
            waiting: false,
        };
    }
    return {
        title: t(`sandbox.connectionNotice.hostedSandboxesSwitchedOff`),
        body: t(`sandbox.connectionNotice.weWontStartMachine`),
        action: { kind: `setup`, label: t(`sandbox.words.runOnMyComputer`) },
        waiting: false,
    };
};

/* THE EDGE'S OWN VERDICT, which is the only thing in this file that can tell a browser's broken network from a sandbox that is simply not there. */
// A machine the platform runs is not dialled in while it sleeps, and the wake reflex is already starting it: that is a
// wait, with the machine's own words once it outlasts one.
const detachedNotice = (input: ConnectionNoticeInput, name: string): ConnectionNotice | undefined =>
    input.failure?.kind === `detached` && !input.hostedMachine && input.outageMs >= DETACHED_AFTER_MS
        ? {
              title: t(`sandbox.connectionNotice.isntConnected`, { name }),
              body: t(`sandbox.connectionNotice.intenticAnsweredAddressSandbox`),
              action: { kind: `setup`, label: t(`sandbox.connectionNotice.checkSetup`) },
              waiting: false,
          }
        : undefined;

// Extension that owns a stalled path, since `/x/<id>/…` is the only route shape in the daemon somebody else wrote.
const extensionOf = (path: string): string | undefined => /^\/x\/([^/]+)/.exec(path)?.[1];

// What the browser actually watched stop answering. Outranks both lane sentences below, and carries no action on
// purpose: neither lane's setup screen repairs a route, and that screen is where a machine gets handed back.
const stalledBody = (path: string | undefined): string | undefined => {
    if (path === undefined) {
        return undefined;
    }
    const extension = extensionOf(path);
    return extension === undefined
        ? t(`sandbox.connectionNotice.routeStoppedAnswering`, { path })
        : t(`sandbox.connectionNotice.extensionStoppedAnswering`, { extension, path });
};

// The wait that has stopped being one, on either lane. Nothing is diagnosed: the machine we run can be looked at, and
// the machine somebody else runs is theirs to look at, which is exactly what each sentence says.
const stuckNotice = (input: ConnectionNoticeInput, name: string): ConnectionNotice | undefined => {
    const patience = input.hostedMachine ? HOSTED_STUCK_AFTER_MS : OWN_STUCK_AFTER_MS;
    if (input.outageMs < patience) {
        return undefined;
    }
    const stalled = stalledBody(input.stalledPath);
    if (stalled !== undefined) {
        return { title: t(`sandbox.connectionNotice.isntAnswering`, { name }), body: stalled, action: undefined, waiting: false };
    }
    return input.hostedMachine
        ? {
              title: t(`sandbox.connectionNotice.isntAnswering`, { name }),
              body: t(`sandbox.connectionNotice.machineWeRunSandbox`),
              action: { kind: `setup`, label: t(`sandbox.connectionNotice.checkMachine`) },
              waiting: false,
          }
        : {
              title: t(`sandbox.connectionNotice.isntAnswering`, { name }),
              body: t(`sandbox.connectionNotice.silentWhileSandboxRuns`),
              action: { kind: `setup`, label: t(`sandbox.connectionNotice.checkSetup`) },
              waiting: false,
          };
};

// THE WAIT WITH A KNOWN CAUSE. Ahead of `detached`, which is the one that would otherwise speak: the edge's verdict
// is true during a swap — the container really isn't dialled in, because it is being replaced — and true is not the
// same as useful. "Its container isn't running" reads as a fault to somebody whose own press stopped it.
const restartNotice = (input: ConnectionNoticeInput): ConnectionNotice | undefined =>
    input.restart === undefined || input.outageMs >= RESTART_PATIENCE_MS
        ? undefined
        : { title: input.restart.title, body: input.restart.detail, action: undefined, waiting: true };

// The network-shaped causes read as one thing (a wait) while waiting can still fix them, then as the most specific
// thing established about them. A refused wake outranks everything, at any age.
const networkNotice = (input: ConnectionNoticeInput, kind: "timeout" | "closed" | "network" | "detached", name: string): ConnectionNotice =>
    suspendedNotice(input, name) ??
    hoursSpentNotice(input, name) ??
    restartNotice(input) ??
    detachedNotice(input, name) ??
    stuckNotice(input, name) ??
    waitingNotice(kind, name);

// The causes that are one fixed sentence whatever else is true, as a table — so the function below holds only the
// decisions that need one, and a new cause cannot be added without giving it words.
type SettledKind = "gone" | "unaddressed" | "unauthenticated" | "forbidden";

const SETTLED: Record<SettledKind, (name: string) => ConnectionNotice> = {
    gone: goneNotice,
    unaddressed: (name) => ({
        title: t(`sandbox.connectionNotice.connect`, { name }),
        body: t(`sandbox.connectionNotice.sandboxIsntConnectedYet`),
        action: { kind: `setup`, label: t(`sandbox.connectionNotice.finishSetup`) },
        waiting: false,
    }),
    unauthenticated: (name) => ({
        title: t(`sandbox.connectionNotice.signInToReach`, { name }),
        body: t(`sandbox.connectionNotice.sandboxUpSessionBrowser`),
        action: { kind: `signin`, label: t(`sandbox.connectionNotice.signInAgain`) },
        waiting: false,
    }),
    // A routed 403 goes elsewhere; kept here so a routing slip still shows accurate words.
    forbidden: (name) => ({
        title: t(`sandbox.connectionNotice.noAccessTo`, { name }),
        body: t(`sandbox.connectionNotice.sandboxRefusedGoogleAccount`),
        action: { kind: `signin`, label: t(`sandbox.connectionNotice.signInAgain`) },
        waiting: false,
    }),
};

const isSettled = (kind: ConnectionFailure[`kind`]): kind is SettledKind => kind in SETTLED;

export const connectionNotice = (input: ConnectionNoticeInput): ConnectionNotice => {
    const { failure } = input;
    const name = input.sandboxName ?? `your sandbox`;
    if (failure === undefined) {
        return {
            title: t(`sandbox.connectionNotice.connectingTo`, { name }),
            body: t(`sandbox.connectionNotice.sandboxReportedInOpening`),
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
