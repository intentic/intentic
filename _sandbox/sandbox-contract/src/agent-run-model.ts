import { quickModelKey, type QuickModelSource } from "./quick-model.js";
import type { AgentRunPin } from "./schemas/agent.js";

/* WHAT A SURFACE-STARTED AGENT RUN OPENS ON, the resolver for `agentRunModels`, sibling to resolveQuickModels
 * and deliberately not the same function.
 *
 * BOTH ARE ORDERED LISTS, FOR THE SAME REASON. One connected account whose allowance went on the chat this
 * morning is enough to take every one of these down: the user presses Fix with agent on a red pipeline, an
 * isolated session opens, and it dies on a credential error they cannot see from the row. Written in order, the
 * next entry catches it.
 *
 * THEY DIFFER ON WHAT AN EMPTY LIST MEANS, and that difference is the whole reason this is its own file rather
 * than a flag on the other one. A quick helper exists to stay OFF the frontier tier, so "work it out from what
 * is connected" is a good answer and quickModel's empty list resolves to a derived Auto ladder. An agent run is
 * a full session with a worktree, billed whole: nothing here can judge whether a job is worth the frontier tier,
 * so an empty list resolves to NOTHING and the caller falls back to the model the user picked for their own
 * chat, a choice they made, rather than one this file guessed for them. For the same reason there is no Auto
 * ladder underneath a list that has been emptied by disconnection: it would spend an account the user never
 * pointed at, on the most expensive kind of run this app starts.
 *
 * WHAT "STEPPED OVER" MEANS HERE IS NARROWER than the quick chain's, and worth being exact about. The quick
 * chain re-asks the next rung when a call comes back refused, because a one-shot that failed has cost nothing
 * and can simply be run again. An agent session cannot be replayed that way, by the time a provider refuses
 * mid-turn the agent may have already edited files, so this list is read ONCE, at the moment the turn is
 * composed, and steps over exactly one thing: an account that is not connected. A model that accepts the turn
 * and fails later is a failed run the user reads on the card, like any other. */

/* The pins that could actually be started right now, in the user's own order.
 *
 * `sources` is the same readiness view resolveQuickModels takes, so both settings rows agree about which
 * accounts this sandbox can send to, a pin greyed as "Not connected" in one row and silently spent by the
 * other would be the worst of both.
 *
 * A pin whose provider is gone is DROPPED rather than held: it would otherwise sit at the head of the chain
 * failing every run, which is exactly what the list exists to prevent. It stays on SCREEN, greyed, the settings
 * row renders the stored list, not this one, because a setting that vanished from view would look like the app
 * had eaten it.
 *
 * THE WHOLE PIN SURVIVES, not the pair inside it: the entry's own effort, harness and cost knobs are what the
 * turn is composed from (turn-resume.ts), so a resolver that handed back a bare (provider, model) would silently
 * run the head of the list at the provider's defaults. Nothing here reads or judges those fields, which is the
 * point of carrying them whole.
 *
 * Empty out means nobody has pinned anything this sandbox can reach, and the caller's floor takes over. */
export const resolveAgentRunModels = (sources: readonly QuickModelSource[], pinned: readonly AgentRunPin[]): readonly AgentRunPin[] => {
    const ready = new Set(sources.filter((source) => source.ready).map((source) => source.provider));
    // Taken verbatim, unvalidated against the catalog, the same reading resolveQuickModels gives its keys and
    // for the same reason: the picker offers a custom-id escape hatch for a model the static catalog has not
    // caught up with, and second-guessing the id here would run a different model than the settings row names.
    const requested = pinned.filter((pin) => ready.has(pin.provider));
    /* The same model twice would spend two attempts proving the same account is out. Hand-edited list, so this
     * is a real state rather than a defensive branch.
     *
     * THE FIRST OF A PAIR WINS, WHOLE. Two entries can now name one model and differ in their knobs (the same
     * Sonnet at Max and again at Low, written while reordering the list), and the one the user reads first is
     * the one they meant; keeping the earlier position with the later entry's effort would run a tier that
     * appears nowhere the pin does. */
    const chain: AgentRunPin[] = [];
    for (const pin of requested) {
        if (!chain.some((held) => quickModelKey(held) === quickModelKey(pin))) {
            chain.push(pin);
        }
    }
    return chain;
};
