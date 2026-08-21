import { compareCheapestFirst, isCheaperRung } from "./model-order.js";
import { parsePinned } from "./quick-model.js";
import type { AgentProvider } from "./schemas.js";

/* WHICH MODEL A DOWNGRADED TURN ACTUALLY RUNS ON, the second half of automatic tier selection.
 * prompt-complexity.ts decides a turn COULD be cheaper; this decides whether there is anything cheaper to put
 * it on, and names it.
 *
 * THERE IS NO "STANDARD TIER" SETTING, and its absence is the design rather than an omission. The standard tier
 * is whatever the user already picked for this conversation. So this mechanism can only ever route DOWN, from a
 * model somebody chose to a cheaper rung of the same catalog, which means the worst case of a wrong answer is
 * one turn's quality on a model the user can see and correct, never a bill they did not ask for. Every
 * ambiguous case in this file therefore resolves to `undefined`, which the caller reads as "run what they
 * asked for".
 *
 * THE PROVIDER IS NEVER CROSSED, and this is the constraint the rest of the app imposes rather than one this
 * file would have chosen. A conversation's provider session is resumed only while the selection still matches
 * the runtime and account that minted it (turnRequest.ts `resumes`, which compares provider, account and
 * harness, and pointedly NOT model). A model swap inside one provider is free, and the session carries on. A
 * provider swap RETIRES the session and cuts a new segment, which throws away the very context that made the
 * follow-up cheap to answer. So a cross-provider pin here is dropped rather than honoured: saving a fraction of
 * a cent by starting the conversation over is not a saving.
 *
 * THE ORDER IS A LADDER, for the reason quick-model.ts is one, but a shorter one: the caller spends the head
 * and falls back to the user's own pick, rather than walking rungs. A downgrade that cannot be started is not
 * worth a second attempt when the honest answer (their model) is sitting right there. */

export interface FastTierInput {
    // The provider this turn is on. Both the pick and every candidate belong to it; see above.
    readonly provider: AgentProvider;
    // The model the user picked, i.e. the standard tier and the ceiling. Empty when the composer has not
    // resolved one yet, which resolves to no downgrade: there is nothing to be cheaper THAN.
    readonly model: string;
    // That provider's catalog as the caller can see it. Empty is a real state (a catalog that has not loaded),
    // and it resolves to no downgrade rather than to a guess.
    readonly models: readonly string[];
    // settings.autoFastModels: an ordered list of `${provider}:${modelId}` keys (quickModelKey), or empty for
    // Auto. Entries naming another provider are dropped, not honoured.
    readonly pinned: readonly string[];
}

/* THE CHEAPER MODEL TO RUN THIS TURN ON, or undefined for "there isn't one, use their pick".
 *
 * A PIN IS TAKEN VERBATIM against the catalog, the same call resolveQuickModels makes and for the same reason:
 * the model picker offers a custom-id escape hatch for a model the static catalog has not caught up with, and
 * second-guessing the id here would run a different model than the settings row names. It is still checked for
 * being CHEAPER, because that is not a fact about the catalog, it is a fact about the id, and a pin that is not
 * cheaper than the pick is not a downgrade at all.
 *
 * AUTO IS THE CHEAPEST ROW THE PROVIDER PUBLISHES, read through the same cheap-end order the quick model uses,
 * so the two features cannot disagree about which rung is the cheap one. Derived, never stored: connect an
 * account tomorrow and the answer improves by itself, exactly as quickModel's empty default does.
 *
 * NOTHING CHEAPER THAN THE PICK ⇒ UNDEFINED, and that is the common case worth being exact about rather than
 * the edge case: a user already working on the cheap rung has nowhere to be sent, and a user on a model whose
 * family this build does not recognize is not going to be downgraded on a guess (isCheaperRung). */
export const fastTierModel = (input: FastTierInput): string | undefined => {
    if (input.model === "") {
        return undefined;
    }
    const pinned = input.pinned
        .flatMap((key) => {
            const choice = parsePinned(key);
            return choice === undefined || choice.provider !== input.provider ? [] : [choice.model];
        })
        .find((model) => isCheaperRung(model, input.model));
    if (pinned !== undefined) {
        return pinned;
    }
    const cheapest = input.models.toSorted(compareCheapestFirst)[0];
    return cheapest !== undefined && isCheaperRung(cheapest, input.model) ? cheapest : undefined;
};
