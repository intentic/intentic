import type { DeviceAgentOp } from "@intentic/sandbox-contract/schemas/devices";
import type { NoticeModel } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// ONE PRESS OF AN AGENT VERB, AS ONE THING WITH AN ENDING. The page used to draw a run as three loose pieces under the
// row — the machine's raw log, a muted sentence, and the concern that had asked for it still standing above them with
// its button live again — so a reader who pressed "Forget them" was left looking at the question they had just
// answered, and nothing on screen said the work was over. A run is now a strip with a state: working, waiting for the
// machine to come back, done, or refused, each with a headline in the page's own words. The log is evidence behind it.

export type AgentRunState = `running` | `waiting` | `done` | `failed`;

/** The links reading a "Forget them" press was made against: what it set out to drop, and what that leaves. */
export interface LinksAsked {
    readonly total: number;
    readonly unreachable: number;
}

export interface AgentRun {
    readonly op: DeviceAgentOp;
    readonly state: AgentRunState;
    /** The machine's own output, verbatim. Shown on request, never instead of the headline. */
    readonly lines: readonly string[];
    /** The machine's closing sentence, when it got to send one. */
    readonly said?: string | undefined;
    /** What the page is waiting on, once the call has ended without the answer (a restarted agent coming back). */
    readonly waiting?: string | undefined;
    readonly links?: LinksAsked | undefined;
    /** The machine's refusal, and the same act as a line to type there. */
    readonly failure?: { readonly notice: NoticeModel; readonly command?: string | undefined } | undefined;
    /** When it was pressed: what the strip's "so far" counts from, and what its deadline is measured against. */
    readonly startedAt?: number | undefined;
    /** Still waiting, past the deadline (deviceWork.ts): no longer work in flight, and worth a word of its own. */
    readonly expired?: boolean | undefined;
}

/** Work still in flight: said on the environment's own row as one spinner, rather than as a strip under it. */
export const agentRunLive = (run: AgentRun | undefined): boolean =>
    run !== undefined && (run.state === `running` || (run.state === `waiting` && run.expired !== true));

// Counted so the headline can say how much was done, never only that something was.
const count = (links: LinksAsked | undefined): number | undefined => (links === undefined || links.unreachable === 0 ? undefined : links.unreachable);

// A change of settings, not of the agent: no process is replaced, so nothing is "coming back" while it runs.
const powerTitle = (state: AgentRunState): string =>
    state === `failed`
        ? t(`sandbox.agentRun.powerFailed`)
        : state === `done`
          ? t(`sandbox.agentRun.powerChanged`)
          : t(`sandbox.agentRun.powerChanging`);

// The WSL memory card's yes: a file written, which the VM takes at WSL's next start.
const wslMemoryTitle = (state: AgentRunState): string =>
    state === `failed`
        ? t(`sandbox.agentRun.wslMemoryFailed`)
        : state === `done`
          ? t(`sandbox.agentRun.wslMemoryWritten`)
          : t(`sandbox.agentRun.wslMemoryWriting`);

/** The strip's headline: what is happening, or what happened, in one line. */
export const agentRunTitle = (run: AgentRun): string => {
    const n = count(run.links);
    switch (run.op) {
        case `forget-unreachable`:
            if (run.state === `failed`) {
                return t(`sandbox.agentRun.forgetFailed`);
            }
            if (run.state === `done`) {
                return n === undefined ? t(`sandbox.agentRun.forgotSome`) : t(`sandbox.agentRun.forgot`, { count: n }, n);
            }
            return n === undefined ? t(`sandbox.agentRun.forgettingSome`) : t(`sandbox.agentRun.forgetting`, { count: n }, n);
        case `upgrade`:
            return run.state === `failed`
                ? t(`sandbox.agentRun.updateFailed`)
                : run.state === `done`
                  ? t(`sandbox.agentRun.updated`)
                  : run.state === `waiting`
                    ? t(`sandbox.agentRun.comingBack`)
                    : t(`sandbox.agentRun.updating`);
        case `restart`:
            return run.state === `failed`
                ? t(`sandbox.agentRun.restartFailed`)
                : run.state === `done`
                  ? t(`sandbox.agentRun.restarted`)
                  : run.state === `waiting`
                    ? t(`sandbox.agentRun.comingBack`)
                    : t(`sandbox.agentRun.restarting`);
        // The two answers to Windows Update's restarts run from the host-power card alone, never from this view: if one is
        // ever shown here, it is a change of the computer's power settings, as stay-on is.
        case `power-stay-on`:
        case `update-pause`:
        case `before-sign-in`:
            return powerTitle(run.state);
        case `wsl-memory`:
            return wslMemoryTitle(run.state);
        default:
            return run.op satisfies never;
    }
};

/**
 * The line under the headline. A finished drop says what it left, in the machine's own unit, instead of the machine's
 * "what it removed is in the lines above" — which pointed at a log the reader should not need to read. Everything
 * else says the machine's own closing sentence, or what the page is waiting on.
 */
export const agentRunDetail = (run: AgentRun): string | undefined => {
    if (run.state === `waiting`) {
        return run.waiting;
    }
    if (run.state === `done` && run.op === `forget-unreachable` && count(run.links) !== undefined && run.links !== undefined) {
        const left = run.links.total - run.links.unreachable;
        return left === 0 ? t(`sandbox.agentRun.noLinksLeft`) : t(`sandbox.agentRun.stillConnected`, { count: left }, left);
    }
    return run.state === `done` ? run.said : undefined;
};

// The maps below are keyed by every op, so an op the contract adds is a type error here rather than another op's words.

/** What a refusal is titled when the machine gave no sentence of its own; one per verb, never "update" for all of them. */
export const agentRefusal = (op: DeviceAgentOp): string =>
    ({
        upgrade: t(`sandbox.useDevices.agentUpdateRefused`),
        restart: t(`sandbox.agentRun.restartRefused`),
        "forget-unreachable": t(`sandbox.agentRun.forgetRefused`),
        "power-stay-on": t(`sandbox.agentRun.powerRefused`),
        "update-pause": t(`sandbox.agentRun.powerRefused`),
        "before-sign-in": t(`sandbox.agentRun.powerRefused`),
        "wsl-memory": t(`sandbox.agentRun.wslMemoryRefused`),
    } satisfies Record<DeviceAgentOp, string>)[op];

/** What the environment's row says beside its spinner while the run is live: the verb, short enough for the row's meta. */
export const agentRunWorking = (op: DeviceAgentOp): string =>
    ({
        upgrade: t(`sandbox.agentRun.working`),
        restart: t(`sandbox.agentRun.workingRestart`),
        "forget-unreachable": t(`sandbox.agentRun.workingForget`),
        "power-stay-on": t(`sandbox.agentRun.workingPower`),
        "update-pause": t(`sandbox.agentRun.workingPower`),
        "before-sign-in": t(`sandbox.agentRun.workingPower`),
        "wsl-memory": t(`sandbox.agentRun.workingWslMemory`),
    } satisfies Record<DeviceAgentOp, string>)[op];

/** What the Devices row and the machine's card say while one is out on a machine, before `doingOn` names the machine. */
export const agentRunDoing = (op: DeviceAgentOp): string =>
    ({
        upgrade: t(`sandbox.deviceOps.workingAgentUpgrade`),
        restart: t(`sandbox.deviceOps.workingAgentRestart`),
        "forget-unreachable": t(`sandbox.deviceOps.workingAgentForget`),
        "power-stay-on": t(`sandbox.deviceOps.workingAgentPower`),
        "update-pause": t(`sandbox.deviceOps.workingAgentPower`),
        "before-sign-in": t(`sandbox.deviceOps.workingAgentPower`),
        "wsl-memory": t(`sandbox.deviceOps.workingAgentWslMemory`),
    } satisfies Record<DeviceAgentOp, string>)[op];

// Update and restart both stop the resident process carrying the request, so the page can't claim an
// outcome: it shows what was watched, then this, and the confirmation is the next poll's version. The
// connection dropping isn't announced here — the log says it in the moment it happens.
/** What the strip waits on once the call has ended without the machine's answer. */
export const agentRunAsked = (op: DeviceAgentOp): string =>
    ({
        upgrade: t(`sandbox.deviceOps.askedUpgrade`),
        restart: t(`sandbox.deviceOps.askedRestart`),
        // The machine restarts its agent against the links it has left, so this page hears the new count the same way it
        // hears a new version: on the loop's next hello, not from this request.
        "forget-unreachable": t(`sandbox.deviceOps.askedForget`),
        // Nothing restarts: the machine's own answer ends the wait, and failing that its next reading does.
        "power-stay-on": t(`sandbox.deviceOps.askedPower`),
        "update-pause": t(`sandbox.deviceOps.askedPower`),
        "before-sign-in": t(`sandbox.deviceOps.askedPower`),
        // Nor does writing .wslconfig (the WSL memory card's yes): the VM takes it at WSL's next start, not now.
        "wsl-memory": t(`sandbox.deviceOps.askedWslMemory`),
    } satisfies Record<DeviceAgentOp, string>)[op];
