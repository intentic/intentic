import type {
    Environment,
    EnvironmentContents,
    EnvironmentDevSwapWait,
    EnvironmentRebuildWait,
    EnvironmentRuntimeDecision,
} from "@intentic/sandbox-contract/schemas/environment";
import { refuse } from "@intentic/contract-serve";
import { demoEnvironment, demoEnvironmentContents } from "../../fixture/sandbox";
import { demoQuiet } from "../../mode";
import { roster } from "../board/roster";

// The environment's image as the owner decides it (the daemon's environment/environment.routes.ts): the agent's
// proposal approved or rejected, a recurring install adopted or dismissed, and a rebuild or a checkout's restart held
// until no agent is mid-turn. The fixture's environment is the opening position; every answer here is it after what
// the page did, so the card's next read and its Contents agree with the press.

// How long a held rebuild waits on the busy agents, and how long the device then builds before the sandbox is back.
const WAIT_MS = 6_000;
const BUILD_MS = 10_000;
// A checkout rebuild's gate is let through, and the restart it held is over, this long after.
const RELEASE_MS = 6_000;
const RESTART_MS = 5_000;

interface EnvironmentState {
    approved: boolean;
    rejected: boolean;
    built: boolean;
    readonly decisions: Map<string, EnvironmentRuntimeDecision[`decision`]>;
    rebuild: EnvironmentRebuildWait | undefined;
    devSwap: EnvironmentDevSwapWait | undefined;
}
const state: EnvironmentState = {
    approved: false,
    rejected: false,
    // The approved overlay is what the running container was built from: the rebuild after approving ran.
    built: false,
    decisions: new Map<string, EnvironmentRuntimeDecision[`decision`]>(),
    rebuild: undefined,
    devSwap: undefined,
};

// The proposal the fixture's agent wrote, read once: approving or rejecting it takes it off the fixture's answer.
const offered = demoEnvironment({ proposal: true }).proposal;

const proposalShown = (): boolean => !demoQuiet(`proposal`) && !state.approved && !state.rejected;

// Each runtime install with the owner's answer on it: adopted is drafted, dismissed is declined until restored.
const withDecisions = (recurring: Environment[`recurring`]): Environment[`recurring`] =>
    recurring?.map((install) => {
        const decision = state.decisions.get(install.tool);
        return { ...install, drafted: decision === `adopt` || install.drafted, declined: decision === `dismiss` || undefined };
    });

export const environmentNow = (): Environment => {
    const base = demoEnvironment({ proposal: proposalShown() });
    const approved = state.approved && offered !== undefined ? offered : base.approved;
    return {
        ...base,
        approved,
        custom: state.approved ? approved : base.custom,
        appliedHash: state.built ? approved?.hash : base.appliedHash,
        recurring: withDecisions(base.recurring),
        rebuildWhenIdle: state.rebuild,
        devSwapWhenIdle: state.devSwap,
        waitsForAgents: true,
    };
};

// The proposal's own block, as Contents lists it: waiting on the owner, then on a rebuild, then in the image.
const IMAGEMAGICK = `imagemagick`;
export const environmentContentsNow = (): EnvironmentContents => {
    const { items } = demoEnvironmentContents({ settled: demoQuiet(`proposal`) });
    return {
        items: items.flatMap((item) => {
            if (item.block !== IMAGEMAGICK) {
                return [item];
            }
            if (state.rejected) {
                return [];
            }
            if (state.built) {
                return [{ ...item, state: `active` as const, tools: [{ name: `magick`, version: `7.1.1-43` }, { name: `convert`, version: `7.1.1-43` }] }];
            }
            return [state.approved ? { ...item, state: `after-rebuild` as const } : item];
        }),
    };
};

/** The owner's yes to the proposal, by the hash they reviewed; refused as the daemon refuses a stale or missing one. */
export const approveProposal = (hash: string): Environment => {
    if (!proposalShown() || offered === undefined) {
        return refuse(`no proposal to approve`, 404);
    }
    if (hash !== offered.hash) {
        return refuse(`the proposal changed since it was reviewed, refresh and re-approve`, 409);
    }
    state.approved = true;
    return environmentNow();
};

export const rejectProposal = (): Environment => {
    state.rejected = true;
    return environmentNow();
};

/** One recurring install: adopt drafts its step, dismiss declines it, restore takes the no back. */
export const decideRuntimeInstall = ({ tool, decision }: EnvironmentRuntimeDecision): Environment => {
    const install = demoEnvironment({ proposal: true }).recurring?.find((entry) => entry.tool === tool);
    if (install === undefined || (decision === `adopt` && install.step === undefined)) {
        return refuse(`no runtime install by that name has a mechanical overlay step`, 404);
    }
    if (decision === `restore`) {
        state.decisions.delete(tool);
    } else {
        state.decisions.set(tool, decision);
    }
    return environmentNow();
};

// Who a restart would cut now: the board's cards mid-turn, by the title the board shows them under.
const busyTitles = (): string[] =>
    roster.agents.filter((agent) => agent.status === `running`).map((agent) => agent.title ?? agent.id).slice(0, 3);

type Timer = ReturnType<typeof setTimeout> | undefined;
// The two waits' pending steps, so asking again or withdrawing replaces the step rather than racing it.
interface WaitTimers {
    rebuild: Timer;
    devSwap: Timer;
}
const timers: WaitTimers = { rebuild: undefined, devSwap: undefined };

// The device builds, then restarts the sandbox onto the approved overlay: the card reads it applied once it is back.
const startBuilding = (wait: EnvironmentRebuildWait): void => {
    state.rebuild = { ...wait, phase: `rebuilding`, waitingOn: [] };
    timers.rebuild = setTimeout(() => {
        state.built = state.approved && wait.hash === offered?.hash ? true : state.built;
        state.rebuild = undefined;
    }, BUILD_MS);
};

/** A rebuild that starts by itself once nobody is mid-turn, or at once when nobody is now. */
export const rebuildWhenIdle = (host: string, hash: string): Environment => {
    clearTimeout(timers.rebuild);
    const wait: EnvironmentRebuildWait = { host, hash, requestedAt: Date.now(), phase: `waiting`, waitingOn: busyTitles() };
    if (wait.waitingOn.length === 0) {
        startBuilding(wait);
    } else {
        state.rebuild = wait;
        timers.rebuild = setTimeout(() => startBuilding(wait), WAIT_MS);
    }
    return environmentNow();
};

export const cancelRebuildWhenIdle = (): Environment => {
    if (state.rebuild?.phase === `rebuilding`) {
        return refuse(`the rebuild has already started on the device, and restarts this sandbox when it is built`, 409);
    }
    clearTimeout(timers.rebuild);
    state.rebuild = undefined;
    return environmentNow();
};

/** A checkout rebuild's restart, let through once nobody is mid-turn; the restart itself is over a few seconds later. */
export const devSwapWhenIdle = (host: string): Environment => {
    clearTimeout(timers.devSwap);
    state.devSwap = { host, requestedAt: Date.now(), phase: `waiting`, waitingOn: busyTitles() };
    timers.devSwap = setTimeout(() => {
        state.devSwap = { host, requestedAt: Date.now(), phase: `released`, waitingOn: [] };
        timers.devSwap = setTimeout(() => (state.devSwap = undefined), RESTART_MS);
    }, RELEASE_MS);
    return environmentNow();
};

export const cancelDevSwapWhenIdle = (): Environment => {
    clearTimeout(timers.devSwap);
    state.devSwap = undefined;
    return environmentNow();
};
