import type { AgentProvider, AgentCapabilities, AgentTurn } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { TurnContext, TurnPlan } from "../run/turn/turn-plan.js";

// The seam every agent runtime sits behind. `preflight` gates the credential, resolves a model, and assembles the
// request, or refuses. `holdsSession` asks the store whether a resume can happen; `health` probes cheaply, off the turn
// path. `capabilities` is the contract's record for the pair.

// Health constructors and the probe wrapper live beside the type they build. One `now` per answer, so `checkedAt` marks
// the probe's own moment.
const now = (): number => Date.now();
export const healthReady = (): AdapterHealth => ({ state: "ready", checkedAt: now() });
export const healthUnavailable = (detail: string): AdapterHealth => ({ state: "unavailable", detail, checkedAt: now() });
// A probe that could not run; distinct from unavailable, so it does not grey out a usable provider.
export const healthUnknown = (): AdapterHealth => ({ state: "unknown", checkedAt: now() });

// Runs a probe's one fallible call, mapping any failure to undefined. Try/catch rather than `.catch()`: a synchronous
// throw produces no promise for `.catch` to attach to and would otherwise escape as an unhandled rejection.
export const attemptProbe = async <T>(fn: () => Promise<T> | T): Promise<T | undefined> => {
    try {
        return await fn();
    } catch {
        return undefined;
    }
};

export interface AdapterHealth {
    // "unknown" is a real answer, not a failure; surfaces treat it as available-but-unverified.
    readonly state: "ready" | "unavailable" | "unknown";
    // Why it cannot serve, in the user's terms; absent when ready.
    readonly detail?: string;
    // When the probe ran, in ms since epoch.
    readonly checkedAt: number;
}

// One runtime's implementation of the seam. `R` is pinned per adapter so the registry can map runtime to adapter
// without a cast, and an adapter cannot be filed under a runtime it does not serve.
export interface AgentAdapter<R extends AgentCapabilities["runtime"] = AgentCapabilities["runtime"]> {
    readonly runtime: R;
    // Gate the credential, resolve the model, and assemble the request, or refuse. `granted` is the persona's narrowed
    // capability manifest; shared so an arm cannot mount what the persona did not grant.
    readonly preflight: (
        services: Services,
        input: AgentTurn,
        context: TurnContext,
        granted: Awaited<ReturnType<Services["capabilities"]["list"]>>,
    ) => Promise<TurnPlan>;
    // Cheap and cached; never on the turn's path.
    readonly health: (services: Services) => Promise<AdapterHealth>;
    // Whether this runtime still holds `sessionId` under `cwd`, from the store rather than the id's existence: a
    // runtime can report an id before the session is saved.
    readonly holdsSession: (services: Services, sessionId: string, cwd: string) => Promise<boolean>;
    // One prompt in, one string out: no tools, no session, no transcript, its own deadline, every failure thrown as the
    // provider's own sentence. Absent for a runtime nothing asks a one-liner of.
    readonly oneShot?: (services: Services, ask: OneShotAsk) => Promise<string>;
}

export interface OneShotAsk {
    // Whose credential and catalog this runs on; a routed provider's helper bills to that vendor.
    readonly provider: AgentProvider;
    readonly prompt: string;
    // Where the model runs; nothing is read from it, but a path that doesn't exist fails the spawn.
    readonly cwd: string;
    readonly model: string;
    // How the pin says to run it; absent means thinking disabled, no effort, no speed request.
    readonly effort?: string | undefined;
    readonly thinking?: boolean | undefined;
    readonly fast?: boolean | undefined;
    // The caller's cancel: a second click, a closed panel.
    readonly signal: AbortSignal;
}
