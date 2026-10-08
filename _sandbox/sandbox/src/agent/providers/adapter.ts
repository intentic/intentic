import type { AgentCapabilities, AgentEvent, Capability, RoutedAgentTurn, SandboxSettings } from "@intentic/sandbox-contract";
import type { TurnPersona } from "../../personas/personas.js";
import type { SteeringQueue } from "../checkpoints/agent-steering.js";
import type { TurnTrim } from "../prompt/window/context-trim.js";
import { opt } from "../../opt.js";
import type { ChildSupervisor } from "../subagents/children.js";
import type { AgentRequest, TurnBase, TurnCredential, TurnSpec } from "./agent-request.js";
import { assertAgentExecution, type AgentExecutionContext } from "../../workload/agent-execution.js";

// The seam every agent runtime sits behind, and everything that crosses it: what the planner hands an arm (TurnContext),
// what the arm answers (TurnArmPlan), and the adapter itself. The planner imports this file; nothing here imports back.

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

export type TurnRefusal = {
    readonly ok: false;
    // The machine-readable discriminator the UI keys off (AgentEvent's `error`); absent on plain failures.
    readonly code?: Extract<AgentEvent, { kind: "error" }>["code"];
    readonly message: string;
    // `sandbox-memory-low` only: the cgroup reading behind it, so the refusal can offer the raise rather than
    // describe it. Rides the refusal onto the error frame of the same name.
    readonly memory?: Extract<AgentEvent, { kind: "error" }>["memory"];
    // The account the refusal is about, where the arm resolved one; rides onto the error frame.
    readonly account?: string;
};

// What one runtime's arm answers when it serves: the request it planned, and its loop bound to everything in that request
// but the words, which are all the route may still change. Nothing about experiments or the preamble.
export interface ArmPlan {
    readonly ok: true;
    readonly run: (spec: TurnSpec) => AsyncGenerator<AgentEvent>;
    // The provider account serving this turn, stamped onto usage/rate-limit frames and the activity log;
    // undefined for a container-env credential or an untracked translator subscription.
    readonly account?: string;
    readonly request: AgentRequest;
}

export type TurnArmPlan = TurnRefusal | ArmPlan;

// Pairs a loop with a request carrying a credential that loop spends, checked here where the arm builds it.
export const armPlan = <C extends TurnCredential>(
    loop: (request: AgentRequest<C>) => AsyncGenerator<AgentEvent>,
    request: AgentRequest<C>,
    account?: string,
): ArmPlan => {
    const execution = request.execution;
    return {
        ok: true,
        run: (spec) => {
            assertAgentExecution(execution, spec);
            return loop({ ...request, execution, spec });
        },
        ...opt("account", account),
        request,
    };
};

// What the route has already resolved before a provider can be picked: the request every arm builds on, the turn's two
// cwds (see runTurn), and the seams only some arms use.
export interface TurnContext {
    readonly base: TurnBase;
    // Workspace-relative attachments, already resolved to absolute paths and escape-checked by the route.
    readonly attachmentPaths: readonly string[];
    // The tree as the daemon reaches it; anything the daemon itself touches (hashline edits, the dependency probe) must
    // use this, not effectiveCwd.
    readonly localCwd: string;
    // The workspace root as the agent sees it; what a session id is looked up against.
    readonly effectiveCwd: string;
    readonly cliEnv: Record<string, string>;
    // Mid-turn steering, present only where the runtime declares it (capabilitiesOf().steering).
    readonly steering: SteeringQueue | undefined;
    // Resolved once above the provider split; optional only for a focused caller that invokes an arm directly.
    readonly settings?: SandboxSettings;
    readonly conversationTurns?: number;
    readonly iqSearchEnabled?: boolean;
    // The gateway replaces this turn's old tool results (privacy/gateway/tool-result-clearing.ts); decided with the
    // turn's experiment arms, read by the harness plan when it routes the credential.
    readonly toolResultClearing?: boolean;
    // What the model's declared window will not pay for (context-trim.ts), resolved once above everything that reads
    // it. Absent means the window is unknown or large enough, which is every model outside a local one's card.
    readonly contextTrim?: TurnTrim;
    readonly iqSearchCohort?: string;
    // Who the turn is and what it may do, resolved once by planTurn; absent on the context the route builds before a
    // card is read.
    readonly persona?: TurnPersona;
    // Re-takes the pre-turn rebase while parked on a card; isolated, harness-only turns, since only the harness's cards
    // park long enough to need it.
    readonly resync?: () => Promise<AgentEvent | undefined>;
    // Child-agent supervision, injected by agent.routes like `resync`; absent for a conversationless turn or a focused
    // caller with no route.
    readonly children?: ChildSupervisor;
}

// One runtime's implementation of the seam. `R` is pinned per adapter so the table can map runtime to adapter without a
// cast, and `D` is what the adapter reads of the daemon: named per runtime, handed in by whoever holds more.
export interface AgentAdapter<R extends AgentCapabilities["runtime"], D> {
    readonly runtime: R;
    // Gate the credential, resolve the model, and assemble the request, or refuse. `granted` is the persona's narrowed
    // capability manifest; shared so an arm cannot mount what the persona did not grant.
    // `input` has its provider and loop named: routed at the door it came in through (withRuntimeDefaults).
    readonly preflight: (deps: D, input: RoutedAgentTurn, context: TurnContext, granted: readonly Capability[]) => Promise<TurnArmPlan>;
    // Cheap and cached; never on the turn's path.
    readonly health: (deps: D) => Promise<AdapterHealth>;
    // Whether this runtime still holds `sessionId` in the admitted execution view, from the store rather than the id's
    // existence. Process-capable probes must enter that view or refuse; a string cwd is not execution authority.
    readonly holdsSession: (deps: D, sessionId: string, execution: AgentExecutionContext) => Promise<boolean>;
    // This runtime's arm and loop honour `policy.sealed` (agent-request.ts): a helper's request, no tools, no session,
    // answered once. Absent, nothing sealed is sent to it, since a loop that ignored the flag would run with its tools.
    readonly sealed?: true;
}
