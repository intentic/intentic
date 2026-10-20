import type { AgentProvider, ModelPin } from "../schemas/agent.js";
import type { FleetCapacity, ModelRef } from "./plan-pools.js";

// The order to try models in for a job's setup (model-setups.ts), shared by daemon and browser so both agree what a job
// will spend before it runs. An empty list resolves to nothing: the caller decides what that means (a helper is off; a
// run falls back to the chat's own pick).

// One provider's standing in the decision: can a turn go, and what its catalog holds. ACP agents have no rung here (an
// empty model id), but endpoint/<id> providers must be included, matching the picker's own options.
export interface ModelSource {
    // AgentProvider, not NativeProvider: an endpoint's id is user-created, no fixed union; nothing here ranks cost.
    readonly provider: AgentProvider;
    // Same connection predicate every surface gates on; a nonempty catalog does not imply ready to send.
    readonly ready: boolean;
    // The models it can run a turn on, newest-first order not assumed. readyChain never reads it (a pin is verbatim);
    // a preset setup is worked out from it (model-setups.ts `presetPins`), so a helper-only model is left out.
    readonly models: readonly string[];
}

export interface ModelChoice {
    readonly provider: AgentProvider;
    readonly model: string;
}

// A (provider, model) pair on the wire: `${provider}:${modelId}`, the same key shape the picker mints. Used to compare
// entries and dedupe a role list.
export const modelPinKey = (choice: ModelChoice): string => `${choice.provider}:${choice.model}`;

// Splits on the first colon only: a provider id never contains one, a model id might. Exported since a stored key
// stores these keys.
export const parsePinned = (pinned: string): ModelChoice | undefined => {
    const separator = pinned.indexOf(`:`);
    if (separator <= 0 || separator === pinned.length - 1) {
        return undefined;
    }
    return { provider: pinned.slice(0, separator), model: pinned.slice(separator + 1) };
};

// Filters pinned entries to ready providers only; there is no floor beneath a written list, so an account left unnamed
// is never reached. Returns whole pins, not bare pairs, since effort, thinking and harness must survive with the pick.
export const readyChain = (sources: readonly ModelSource[], pinned: readonly ModelPin[]): readonly ModelPin[] => {
    const ready = new Set(sources.filter((source) => source.ready).map((source) => source.provider));
    // Taken verbatim, unvalidated: the picker's custom-id escape hatch must run exactly the id it names.
    const requested = pinned.filter((pin) => ready.has(pin.provider));
    // First occurrence wins, whole: two entries can name one model with different knobs, and the earlier is meant.
    const chain: ModelPin[] = [];
    for (const pin of requested) {
        if (!chain.some((held) => modelPinKey(held) === modelPinKey(pin))) {
            chain.push(pin);
        }
    }
    return chain;
};

// The model a rung asks capacity about (plan-pools.ts fleetCapacity): an ACP agent's empty id asks about the provider's
// accounts as a whole.
export const rungModel = (choice: ModelChoice): ModelRef | undefined => (choice.model === `` ? undefined : { id: choice.model });

// The rung a ready chain opens on: the first whose capacity no connected account is spent on and that `steppedOver`
// (what else the caller knows, the daemon's failing streaks) lets through, else the head, since every reading that
// stepped one over is a snapshot that may already be stale. The daemon's run roles open on it (run-role-model.ts) and
// the editor names it on the job's button (roleModel.ts), each over the same capacity verdict, so the button never
// names a rung the run would step over. 2026-10-20: the editor took the head by readiness alone, and named a spent
// account's model while the run opened on the next.
export const openingRung = <T extends ModelChoice>(
    chain: readonly T[],
    capacityOf: (rung: T) => FleetCapacity | undefined,
    steppedOver: (rung: T) => boolean = () => false,
): T | undefined => chain.find((rung) => capacityOf(rung)?.kind !== `spent` && !steppedOver(rung)) ?? chain[0];
