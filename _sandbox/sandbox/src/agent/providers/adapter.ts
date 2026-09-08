import type { AgentProvider, AgentCapabilities, AgentTurn } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { TurnContext, TurnPlan } from "../run/turn/turn-plan.js";

/* THE SEAM EVERY AGENT RUNTIME SITS BEHIND.
 *
 * There were four of these before this file, and no interface: `planTurn` branched on the runtime and each arm
 * hand-rolled the same four steps, gate the credential, resolve a concrete model, name the runner, assemble
 * the request. Nothing held them to a common shape, and the drift was the predictable kind: Codex learned that
 * an omitted model lets the SDK's built-in default leak through, and Grok learned the same lesson separately,
 * months later. The session-existence preflight was copied three times almost verbatim.
 *
 * WHAT AN ADAPTER OWES, and why each part is here rather than at the call site:
 *
 * `preflight` is the arm itself, the one thing genuinely per-runtime. It answers with a PLAN or a REFUSAL,
 * never a throw, because everything it can discover (no subscription connected, an uninstalled agent
 * capability) is an ordinary state of a sandbox rather than a failure.
 *
 * `holdsSession` is which store to ask whether a resume can still happen. Only that, what a missing session
 * MEANS is the same for every runtime and belongs to the one caller (agent.routes.ts), which is what stops the
 * three arms answering it three ways again.
 *
 * `health` is new, and it is the reason this is an interface rather than a lookup table. A runtime whose CLI is
 * missing, whose account is signed out, or whose version is too old was previously discoverable in exactly one
 * way: send it a turn and read the error. That is the worst possible moment to find out, the user has written
 * a prompt and picked a model, and the answer comes back as a failed turn. Asking the same question cheaply,
 * off the turn path, is what lets the picker say so first.
 *
 * `capabilities` is the contract's own record for the pair, carried here so a registration cannot claim an
 * ability its runtime does not have, see how the declarations below use it. */

/* The health vocabulary's constructors and the probe wrapper, HERE beside the type they build rather than in
 * the registry that used to own them, because the adapters now live in their provider directories
 * (provider-module.ts) and every one of them speaks this vocabulary. One `now` per answer, so `checkedAt` is
 * the probe's own moment. */
const now = (): number => Date.now();
export const healthReady = (): AdapterHealth => ({ state: "ready", checkedAt: now() });
export const healthUnavailable = (detail: string): AdapterHealth => ({ state: "unavailable", detail, checkedAt: now() });
// A probe that could not run at all. NOT "unavailable": a network blip on an account listing must not grey out
// a provider the user can in fact use, see AdapterHealth.state.
export const healthUnknown = (): AdapterHealth => ({ state: "unknown", checkedAt: now() });

/* Run a probe's one fallible call, mapping ANY failure to undefined, which every caller reads as "unknown".
 *
 * A try/catch rather than `.catch()` on the returned promise, because the two do not catch the same things: a
 * store that throws SYNCHRONOUSLY (a bad path, a mock, a getter that blows up before it can return a promise)
 * never produces a promise for `.catch` to attach to, and the throw escapes into the caller. Here that caller
 * is a background timer, so it would surface as an unhandled rejection every five minutes rather than as the
 * "unknown" this is all built to answer with. */
export const attemptProbe = async <T>(fn: () => Promise<T> | T): Promise<T | undefined> => {
    try {
        return await fn();
    } catch {
        return undefined;
    }
};

export interface AdapterHealth {
    /* Can this runtime serve a turn right now?
     *
     * "unknown" is a real answer and not a failure: a probe that could not run (the daemon is still booting, a
     * network blip on the account check) must not read as "unavailable" and grey out a provider the user can
     * in fact use. Surfaces treat it as available-but-unverified. */
    readonly state: "ready" | "unavailable" | "unknown";
    // Why it cannot serve, in the user's terms and naming what to do about it. Absent when ready.
    readonly detail?: string;
    // When the probe ran, ms since epoch, so a surface can say how stale its answer is.
    readonly checkedAt: number;
}

/* One runtime's implementation of the seam. `R` is pinned per adapter so the registry can map runtime → adapter
 * without a cast, and so an adapter cannot be filed under a runtime it does not serve. */
export interface AgentAdapter<R extends AgentCapabilities["runtime"] = AgentCapabilities["runtime"]> {
    readonly runtime: R;
    /* Gate the credential, resolve the model, and assemble the request, or refuse. `granted` is the owner's
     * capability manifest AS THIS TURN'S PERSONA MAY SEE IT: read once per turn by the caller, narrowed once by
     * the card, and shared, because three of the four arms need it and re-reading it per arm is a file read on
     * the turn path.
     *
     * NARROWED BEFORE AN ARM EVER SEES IT, which is the whole point of handing it down rather than letting each
     * arm read the manifest itself. An arm builds servers, credentials and plugin loads straight out of this
     * list, so a capability the persona did not grant is one an arm cannot accidentally mount, and a shelf
     * therefore means the same thing on every runtime instead of on whichever one remembered to check. */
    readonly preflight: (
        services: Services,
        input: AgentTurn,
        context: TurnContext,
        granted: Awaited<ReturnType<Services["capabilities"]["list"]>>,
    ) => Promise<TurnPlan>;
    // Cheap, cached, and never on a turn's path, see adapter-health.ts for the caching and the schedule.
    readonly health: (services: Services) => Promise<AdapterHealth>;
    /* Does this runtime still hold `sessionId`, so a turn naming it would CONTINUE rather than open a session
     * with no past? `cwd` is the workspace root as the agent sees it, the key the stores that scope sessions by
     * working directory are asked under.
     *
     * Answered from the store rather than from the id's existence, because the two come apart routinely and the
     * gap is invisible from here: a runtime reports its session id the moment it starts and writes the session
     * out seconds later, so a turn stopped in its opening seconds leaves a live-looking id behind that nothing
     * was ever saved under. */
    readonly holdsSession: (services: Services, sessionId: string, cwd: string) => Promise<boolean>;
    /* ONE PROMPT IN, ONE STRING OUT, on this runtime: no tools, no session, no transcript, no events, its own
     * deadline, and every failure thrown as the provider's own sentence. The shape a helper needs (draft me a
     * commit message) as opposed to the shape a chat needs, which is `preflight`. The helper-role walk
     * (role-model.ts) asks the adapter the contract names for the (provider, harness) the pin states rather than
     * choosing a loop of its own, so a provider that refuses the Claude Code harness (Google does, on its
     * identity line; Cursor has no such road at all) is served on its own runtime for one-liners exactly as it is
     * for turns. Absent for a runtime nothing asks one line of, which the walk reports as a refusal and steps
     * over. */
    readonly oneShot?: (services: Services, ask: OneShotAsk) => Promise<string>;
}

export interface OneShotAsk {
    // Whose credential and catalog this runs on: a routed provider's helper is billed to that vendor.
    readonly provider: AgentProvider;
    readonly prompt: string;
    // The tree the model runs in. Nothing is read from it (no tools), but a runtime spawns or scopes there and
    // a path that doesn't exist fails the spawn.
    readonly cwd: string;
    readonly model: string;
    /* HOW THE PIN SAYS TO RUN IT, and these three are why a helper role's list holds full pins rather than bare
     * (provider, model) keys.
     *
     * They used to not exist, and this seam hardcoded the opposite of each: reasoning off, no effort, no speed
     * request, on the argument that a one-liner has nothing to reason about. That argument is right about the
     * DEFAULT and was being used as a rule, so an owner who deliberately pinned a reasoning model to their commit
     * subjects paid for one and was handed the other, with nothing on screen to say so.
     *
     * ABSENT STILL MEANS THE OLD ANSWER, which is what keeps the default honest: an unconfigured pin runs with
     * thinking disabled and no effort, so the ordinary case is the ~2s call it has always been (claude-one-shot.ts
     * measures the difference). Nothing here invents a value; these are only ever what somebody wrote down. */
    readonly effort?: string | undefined;
    readonly thinking?: boolean | undefined;
    readonly fast?: boolean | undefined;
    // The caller's cancel (a second click, a closed panel).
    readonly signal: AbortSignal;
}
