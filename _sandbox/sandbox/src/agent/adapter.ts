import type { AgentCapabilities, AgentTurn } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import type { TurnContext, TurnPlan, TurnRefusal } from "./turn-plan.js";

/* THE SEAM EVERY AGENT RUNTIME SITS BEHIND.
 *
 * There were four of these before this file, and no interface: `planTurn` branched on the runtime and each arm
 * hand-rolled the same four steps — gate the credential, resolve a concrete model, name the runner, assemble
 * the request. Nothing held them to a common shape, and the drift was the predictable kind: Codex learned that
 * an omitted model lets the SDK's built-in default leak through, and Grok learned the same lesson separately,
 * months later. The session-existence preflight was copied three times almost verbatim.
 *
 * WHAT AN ADAPTER OWES, and why each part is here rather than at the call site:
 *
 * `preflight` is the arm itself — the one thing genuinely per-runtime. It answers with a PLAN or a REFUSAL,
 * never a throw, because everything it can discover (no subscription connected, a session that outlived its
 * transcript, an uninstalled agent capability) is an ordinary state of a sandbox rather than a failure.
 *
 * `health` is new, and it is the reason this is an interface rather than a lookup table. A runtime whose CLI is
 * missing, whose account is signed out, or whose version is too old was previously discoverable in exactly one
 * way: send it a turn and read the error. That is the worst possible moment to find out — the user has written
 * a prompt and picked a model, and the answer comes back as a failed turn. Asking the same question cheaply,
 * off the turn path, is what lets the picker say so first.
 *
 * `capabilities` is the contract's own record for the pair, carried here so a registration cannot claim an
 * ability its runtime does not have — see how the declarations below use it. */

export interface AdapterHealth {
    /* Can this runtime serve a turn right now?
     *
     * "unknown" is a real answer and not a failure: a probe that could not run (the daemon is still booting, a
     * network blip on the account check) must not read as "unavailable" and grey out a provider the user can
     * in fact use. Surfaces treat it as available-but-unverified. */
    readonly state: "ready" | "unavailable" | "unknown";
    // Why it cannot serve, in the user's terms and naming what to do about it. Absent when ready.
    readonly detail?: string;
    // When the probe ran, ms since epoch — so a surface can say how stale its answer is.
    readonly checkedAt: number;
}

/* One runtime's implementation of the seam. `R` is pinned per adapter so the registry can map runtime → adapter
 * without a cast, and so an adapter cannot be filed under a runtime it does not serve. */
export interface AgentAdapter<R extends AgentCapabilities["runtime"] = AgentCapabilities["runtime"]> {
    readonly runtime: R;
    /* Gate the credential, resolve the model, and assemble the request — or refuse. `installed` is the owner's
     * capability manifest, read once per turn by the caller and shared, because three of the four arms need it
     * and re-reading it per arm is a file read on the turn path. */
    readonly preflight: (
        services: Services,
        input: AgentTurn,
        context: TurnContext,
        installed: Awaited<ReturnType<Services["capabilities"]["list"]>>,
    ) => Promise<TurnPlan>;
    // Cheap, cached, and never on a turn's path — see adapter-health.ts for the caching and the schedule.
    readonly health: (services: Services) => Promise<AdapterHealth>;
}

/* THE REFUSAL THREE ARMS USED TO SPELL OUT SEPARATELY. A session id that outlived the store holding it is the
 * single most common way a turn fails for a reason the client can act on, and the action is always the same:
 * drop the dead id so the next send starts fresh. Coded, because the UI keys the drop off the code — a plain
 * message would leave the client re-sending the same dead id on every retry, which is what it used to do.
 *
 * `probe` is the runtime's own existence check. Passing it in rather than branching keeps the one thing that
 * genuinely differs per runtime (which store to ask) separate from the thing that must not (what a missing
 * session means and how it is reported). */
export const missingSession = async (sessionId: string | undefined, probe: (id: string) => Promise<boolean>): Promise<TurnRefusal | undefined> => {
    if (sessionId === undefined || (await probe(sessionId))) {
        return undefined;
    }
    return {
        ok: false,
        code: "session-not-found",
        message: "This chat's session no longer exists on the sandbox — it was deleted or lost in a rebuild. The next message starts a fresh session.",
    };
};
