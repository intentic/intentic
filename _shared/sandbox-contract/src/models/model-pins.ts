import { modelsFor } from "./agent-catalog.js";
import type { AgentProvider, ModelPin } from "../schemas/agent.js";

/* WHICH MODELS A ROLE MAY RUN, IN THE ORDER TO TRY THEM. One resolver over every list in
 * settings.modelRoles, and the browser and the daemon both read it.
 *
 * IT IS AN ORDER, NOT A MODEL, and that is the shape of every list this file answers for. A single pick is a
 * single point of failure: the account it names spends its allowance on the chat all morning, and the role
 * fails on a limit for the rest of the day while three other connected providers sit idle. So a setting is a
 * LIST read top to bottom, this hands back the whole ladder, and the caller walks it until one answers. Nothing
 * here decides WHICH failures are worth stepping over — only the runner has made the call and seen it fail —
 * this side says what the running order is.
 *
 * THE RULE LIVES IN THE CONTRACT because both sides need the same answer for different jobs: the daemon runs
 * the model, and the browser has to NAME it, in that job's settings row, before anything has run. Two
 * implementations would drift precisely where it matters most, since a row promising Haiku while the daemon
 * bills Opus is worse than no row at all.
 *
 * AN EMPTY LIST RESOLVES TO NOTHING, FOR EVERY ROLE, and this file no longer derives a floor for any of them.
 * It used to: a `helper` role with no list got an "Auto ladder" worked out from whatever was connected —
 * every provider's cheapest row, best-first — so an owner who had never opened the settings page still got
 * commit messages, session titles and safety verdicts from a model this file picked. That was the wrong
 * default, and the settings row saying "Auto: Gemini 3 Flash Lite, then Claude Haiku 4.5, then …" was the
 * tell: a recommendation nobody asked for, over accounts they had connected for something else, changing
 * under them whenever an account was added. NOT SET NOW MEANS NOT SET. Nothing is auto-selected and nothing
 * is recommended: the owner names the models for a job or the job does not run, which is a state they can
 * read off the row and a bill they cannot be surprised by.
 *
 * The two kinds of role (model-roles.ts) still differ in what the CALLER does with an empty answer — a
 * `helper` is simply off, a `run` falls to the model the owner picked for their own chat — but that is the
 * caller's business, and nothing here has to know which kind it is holding. */

/* One provider's standing in the decision: whether a turn on it can be sent at all, and what its catalog holds.
 *
 * ACP agents are deliberately not expressible here — an ACP row's model id is empty because the agent owns its
 * own model, so there is no rung to point it at. `endpoint/<id>` providers ARE, and have to be: their models
 * appear in the same picker the settings rows build their options from, so a pin naming one has to hold rather
 * than drop out and leave the job running on an account the user was deliberately steering away from. */
export interface ModelSource {
    // AgentProvider, not NativeProvider: an endpoint's id is user-created and cannot be in a fixed union, and
    // what a turn on somebody's own model server costs is not a fact this repo can know — which is fine here,
    // because nothing on this side ranks anything. A pin either names a provider that can run it or it does not.
    readonly provider: AgentProvider;
    // The same connection predicate every other surface gates on (access.ts web-side, the daemon's own account
    // stores daemon-side). A catalog is never empty by construction, so "has rows" says nothing about "can send".
    readonly ready: boolean;
    // What the provider publishes. NOTHING IN THIS FILE READS IT any more: it was the input to the derived Auto
    // ladder, and a pin is taken verbatim. Kept because it is what a source IS, and the daemon's helper walk
    // still gathers it (role-model.ts); a caller with no catalog to hand passes an empty list and loses nothing.
    readonly models: readonly string[];
}

export interface ModelChoice {
    readonly provider: AgentProvider;
    readonly model: string;
}

// A (provider, model) pair on the wire: `${provider}:${modelId}`, the same key shape the model picker mints for
// its entries (PickerEntry.key). Every role list stores PINS rather than these keys — an entry says how it runs
// as well as which model it is — but the key is still how two entries are compared, how a role list dedupes,
// and how `autoFastModels` (which pins no knobs, see its own note in settings.ts) is stored.
export const modelPinKey = (choice: ModelChoice): string => `${choice.provider}:${choice.model}`;

/* Split on the FIRST colon only: a provider id never contains one and a model id might. Exported because
 * `autoFastModels` stores these keys, and because a session composed from a pin travels as one
 * (composeSession). */
export const parsePinned = (pinned: string): ModelChoice | undefined => {
    const separator = pinned.indexOf(`:`);
    if (separator <= 0 || separator === pinned.length - 1) {
        return undefined;
    }
    return { provider: pinned.slice(0, separator), model: pinned.slice(separator + 1) };
};

/* A pin as a person reads it: the catalog's own label for the id, or the id itself for one the static catalog
 * has not caught up with (the picker offers a custom-id escape hatch, so this is a real case rather than a
 * defensive branch). Beside parsePinned because the two are always wanted together, by any surface that has to
 * name what a click is about to spend BEFORE it spends it, and the two loudest of those are extensions that
 * share no other code with each other. */
export const pinnedModelLabel = (choice: ModelChoice): string =>
    modelsFor(choice.provider).find((option) => option.value === choice.model)?.label ?? choice.model;

/* WHICH MODELS THIS ROLE MAY RUN, IN THE ORDER TO TRY THEM, given what this sandbox has connected.
 * `pinned` is the stored setting: settings.modelRoles[role], an ordered list of pins.
 *
 * A pin only holds while its provider is READY: an account the user disconnected would otherwise sit at the
 * head of the chain failing on a credential error while the sandbox can plainly still answer from the rung
 * below. It stays on SCREEN, greyed — the settings row renders the stored list, not this one — because a
 * setting that vanished from view would look like the app had eaten it.
 *
 * THE PINNED LIST IS THE WHOLE ANSWER, and there is nothing underneath it. A user who writes down three models
 * has said which accounts this job may spend, and reaching for a fourth when all three are out is exactly the
 * "spend an account they were steering away from" failure a pin exists to prevent. A user who writes down none
 * has said the job picks no model at all.
 *
 * THE WHOLE PIN SURVIVES, not the pair inside it: an entry's effort, thinking, speed and harness are what the
 * work is composed from, so a resolver handing back a bare (provider, model) would silently run the head of the
 * list at the provider's defaults. Nothing here reads or judges those fields, which is the point of carrying
 * them whole.
 *
 * EMPTY OUT MEANS THE LIST HAS NOTHING IT MAY REACH, from two different causes the caller can tell apart by
 * looking at `pinned`: an empty list is an owner who set no model, and a full list that survives none of the
 * readiness filter is an owner whose accounts have gone. The first is the job being switched off, the second
 * is worth a sentence about the accounts.
 *
 * ONE FUNCTION FOR BOTH KINDS OF LADDER, and it is `resolveRoleModels` that stopped existing rather than this
 * one arriving to replace it. A role's list used to add the role's own floor beneath the ready chain, which is
 * the only thing it did that a persona card's list (schemas/personas.ts `personaModels`) did not — so the walk
 * was split out to be shared. With the floor gone there is no difference left to share around: a role's list
 * and a card's list are the same question over the same sources, and two names for it would be two places to
 * read before believing they agree. */
export const readyChain = (sources: readonly ModelSource[], pinned: readonly ModelPin[]): readonly ModelPin[] => {
    const ready = new Set(sources.filter((source) => source.ready).map((source) => source.provider));
    // Taken verbatim, unvalidated against the catalog on purpose: the picker offers a custom-id escape hatch for
    // a model a catalog hasn't caught up with, and second-guessing the user's own id here would silently run a
    // different model than the settings row names.
    const requested = pinned.filter((pin) => ready.has(pin.provider));
    /* The same model twice would spend two attempts proving one account is out — a real state, since the list is
     * hand-edited and the bulk editor writes one pin across many jobs.
     *
     * THE FIRST OF A PAIR WINS, WHOLE. Two entries can name one model and differ in their knobs (the same Sonnet
     * at Max and again at Low, written while reordering the list), and the one the user reads first is the one
     * they meant; keeping the earlier position with the later entry's effort would run a tier that appears
     * nowhere the pin does. */
    const chain: ModelPin[] = [];
    for (const pin of requested) {
        if (!chain.some((held) => modelPinKey(held) === modelPinKey(pin))) {
            chain.push(pin);
        }
    }
    return chain;
};
