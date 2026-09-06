import { accessFor, modelsFor, PROVIDERS } from "./agent-catalog.js";
import { ACCESS_COST } from "./provider-specs.js";
import { compareCheapestFirst, familyOf, tierRankOf } from "./model-order.js";
import { type ModelRole, modelRole } from "./model-roles.js";
import type { AgentProvider, ModelPin } from "./schemas/agent.js";

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
 * the model, and the browser has to NAME it, in the settings row's "Auto: …" line, before anything has run. Two
 * implementations would drift precisely where it matters most, since a row promising Haiku while the daemon
 * bills Opus is worse than no row at all.
 *
 * WHAT AN EMPTY LIST MEANS IS THE ROLE'S OWN ANSWER (model-roles.ts): a `helper` role derives the Auto ladder
 * from whatever is connected, a `run` role resolves to nothing and lets the caller's floor answer. That fork
 * used to be two near-identical files; it is one line here because it was always one difference. */

/* One provider's standing in the decision: whether a turn on it can be sent at all, and what its catalog holds.
 *
 * ACP agents are deliberately not expressible here — an ACP row's model id is empty because the agent owns its
 * own model, so there is no rung to point it at. `endpoint/<id>` providers ARE, and have to be: their models
 * appear in the same picker the settings rows build their options from, so a pin naming one has to hold rather
 * than fall silently back to Auto and spend an account the user was deliberately steering away from. */
export interface ModelSource {
    // AgentProvider, not NativeProvider: an endpoint's id is user-created and cannot be in a fixed union. Auto's
    // ranking degrades gracefully for one, costOf falls to the metered rung and an id with no tier word is
    // UNRANKED, which is genuine last place, so an endpoint effectively only wins Auto when nothing else is
    // connected, while a PIN on one holds. Both are the right answers: what a turn on someone's own model server
    // costs is not a fact this repo can know, so it is not one Auto should be asserting.
    readonly provider: AgentProvider;
    // The same connection predicate every other surface gates on (access.ts web-side, the daemon's own account
    // stores daemon-side). A catalog is never empty by construction, so "has rows" says nothing about "can send".
    readonly ready: boolean;
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

// The cheapest row a provider publishes, its whole catalog read from the cheap end. Undefined for a catalog
// that hasn't loaded yet, which is a real state: every provider serves a floor, but only once something has
// asked it.
const cheapestOf = (source: ModelSource): string | undefined => source.models.toSorted(compareCheapestFirst)[0];

// Where a provider's cheapest row sits on the shared tier scale, and therefore how well it answers the question
// Auto asks. UNRANKED (-1) is a genuine last place: it means the id carries no tier word we know, so the row is
// the provider's base line rather than its budget one.
const tierOf = (model: string): number => tierRankOf(familyOf(model));

// PROVIDERS order, as the final tiebreak. Arbitrary, but the SAME arbitrary answer on every read, the property
// compareUnrankedModelIds exists to guarantee, and the one a default actually needs. An endpoint is in no fixed
// list, so it reads -1 and leads the tiebreak; unreachable in practice, since it can never tie on cost.
const providerOrder = (provider: AgentProvider): number => PROVIDERS.findIndex((entry) => entry.value === provider);

/* WHAT AN ENDPOINT COSTS, one rung past every provider's, and the reason it is a number here rather than a
 * member of AccessKind. That axis describes the providers this repo ships, and every one of them is unlocked by
 * signing in to something the user already holds, so none of them is metered per call. An endpoint is the
 * opposite: whatever gateway somebody pointed us at, whose bill this repo cannot see. Reading it as dearer than
 * anything on the table is the conservative answer, and it is what keeps Auto from reaching for a paid gateway
 * on its own initiative. */
const METERED_COST = Math.max(...Object.values(ACCESS_COST)) + 1;

// How much a call on this provider costs at the margin. Every native provider declares an access kind; an
// endpoint declares none, and takes the metered rung above.
const costOf = (provider: AgentProvider): number => {
    const access = accessFor(provider);
    return access === undefined ? METERED_COST : ACCESS_COST[access.kind];
};

/* AUTO, every connected provider's cheapest row, best-first, as a ladder rather than a winner. The floor under
 * every `helper` role, and under nothing else.
 *
 * Ranked on TIER FIRST, then cost. That order is the point: a helper's Auto exists to not be the frontier
 * model, so a free flagship is still the wrong tool, while a free Haiku-class row and a subscription
 * Haiku-class row differ only in whose quota they spend. Cost then breaks that tie towards the channel the user
 * is not paying per token for, and against the one they are.
 *
 * NOTE WHAT AUTO IS AND IS NOT AN ARGUMENT FOR. It is the answer for an owner who has said nothing, not a claim
 * that cheap is right: an owner who pins Opus to commit messages is not being talked out of it, which is the
 * whole reason these lists are per role. Auto is what a row says while it is empty.
 *
 * The whole ladder, not just its head, because the same ranking that picks the best answer also states the best
 * SECOND answer, and a sandbox with three accounts connected should not lose its commit messages for six hours
 * because one of them is spent. */
export const autoLadder = (sources: readonly ModelSource[]): readonly ModelPin[] =>
    sources
        .filter((source) => source.ready)
        .flatMap((source) => {
            const model = cheapestOf(source);
            return model === undefined ? [] : [{ provider: source.provider, model }];
        })
        .toSorted(
            (left, right) =>
                tierOf(right.model) - tierOf(left.model) ||
                costOf(left.provider) - costOf(right.provider) ||
                providerOrder(left.provider) - providerOrder(right.provider),
        );

/* WHICH MODELS THIS ROLE MAY RUN, IN THE ORDER TO TRY THEM, given what this sandbox has connected.
 * `pinned` is the stored setting: settings.modelRoles[role], an ordered list of pins, empty for the role's own
 * floor.
 *
 * A pin only holds while its provider is READY: an account the user disconnected would otherwise sit at the
 * head of the chain failing on a credential error, when the sandbox can plainly still answer. Dropping it is
 * the same move the composer already makes when a live catalog stops offering the selected model. It stays on
 * SCREEN, greyed — the settings row renders the stored list, not this one — because a setting that vanished
 * from view would look like the app had eaten it.
 *
 * THE PINNED LIST IS THE WHOLE ANSWER whenever any of it survives that filter. The floor is NOT appended
 * underneath, and that is deliberate: a user who writes down three models has said which accounts this job may
 * spend, and quietly reaching for a fourth when all three are out is exactly the "spend an account they were
 * steering away from" failure a pin exists to prevent. When NONE of the pins is connected any more the list has
 * stopped saying anything about this sandbox, so the floor takes over rather than leaving a dead button.
 *
 * THE WHOLE PIN SURVIVES, not the pair inside it: an entry's effort, thinking, speed and harness are what the
 * work is composed from, so a resolver handing back a bare (provider, model) would silently run the head of the
 * list at the provider's defaults. Nothing here reads or judges those fields, which is the point of carrying
 * them whole.
 *
 * Empty out means the role has nothing it can reach. For a `helper` that is a sandbox with nothing connected at
 * all, and the caller renders a control that says so rather than a live button that fails on click; for a `run`
 * it is the ordinary state of an unpinned role, and the caller's own floor answers. */
export const resolveRoleModels = (sources: readonly ModelSource[], pinned: readonly ModelPin[], role: ModelRole): readonly ModelPin[] => {
    const chain = readyChain(sources, pinned);
    if (chain.length > 0) {
        return chain;
    }
    // The floor, which the role declares. An id outside the table has no floor to fall to, and answering with
    // the cheapest connected model for it would be this file inventing a job.
    return modelRole(role)?.kind === `helper` ? autoLadder(sources) : [];
};

/* THE PINS THIS SANDBOX CAN REACH, IN THE ORDER THEY WERE WRITTEN, the walk under every ladder here: a role's
 * list (resolveRoleModels, which adds the role's floor beneath it) and a persona card's (schemas/personas.ts
 * personaModels, which adds nothing, a card has no floor). Empty when nothing on the list is connected. */
export const readyChain = (sources: readonly ModelSource[], pinned: readonly ModelPin[]): readonly ModelPin[] => {
    const ready = new Set(sources.filter((source) => source.ready).map((source) => source.provider));
    // Taken verbatim, unvalidated against the catalog on purpose: the picker offers a custom-id escape hatch for
    // a model a catalog hasn't caught up with, and second-guessing the user's own id here would silently run a
    // different model than the settings row names.
    const requested = pinned.filter((pin) => ready.has(pin.provider));
    /* The same model twice would spend two attempts proving one account is out — a real state, since the list is
     * hand-edited and Auto's ladder can rank a provider the user has also pinned.
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
