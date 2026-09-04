import { accessFor, modelsFor, PROVIDERS } from "./agent-catalog.js";
import { ACCESS_COST } from "./provider-specs.js";
import { compareCheapestFirst, familyOf, tierRankOf } from "./model-order.js";
import type { AgentProvider } from "./schemas/agent.js";

/* THE QUICK MODEL, the cheap, fast model a small automatic job spends instead of the frontier model the chat
 * runs on. Today that is the commit message written when an agent's work lands; anything else of that shape (a
 * branch name, a PR description) reads the same answer, which is the reason this is a `quickModel` setting
 * rather than a commit-message one.
 *
 * IT IS AN ORDER, NOT A MODEL, and that is the whole shape of this file. A single pick is a single point of
 * failure: the account it names spends its allowance on the chat all morning, and every job for the rest of the
 * day fails on a limit while three other connected providers sit idle. So the setting is a LIST
 * read top to bottom, the resolver hands back the whole ladder, and the daemon walks it until one answers.
 * Nothing here decides WHICH failures are worth stepping over, that is the daemon's, since only it has run
 * the call, this side only says what the running order is.
 *
 * The rule lives in the contract because BOTH sides need the same answer for different jobs: the daemon runs
 * the model, and the browser has to NAME it, in the settings row's "Auto (…)" label, before anything has been
 * run. Two implementations would drift precisely where it matters most, since a label promising Haiku while the
 * daemon bills Opus is worse than no label.
 *
 * The default is DERIVED, NEVER STORED. `quickModel` ships EMPTY and that means "work it out from whatever is
 * connected right now", so connecting a Google account tomorrow improves the default by itself and
 * disconnecting a pinned provider degrades to Auto instead of to a dead button. Same instinct as the rest of
 * this repo's model handling: model-order.ts derives tier and recency from the id and curates nothing, and the
 * web's defaultModelFor reads the live catalog rather than naming an id that a release will falsify. */

/* One provider's standing in the decision: whether a turn on it can be sent at all, and what its catalog holds.
 *
 * ACP agents are deliberately not expressible here, an ACP row's model id is empty because the agent owns its
 * own model, so there is no cheap rung to point it at. `endpoint/<id>` providers ARE, and have to be: their
 * models appear in the same picker the settings row builds its options from, so a pin naming one has to hold
 * rather than fall silently back to Auto and spend an account the user was deliberately steering away from. */
export interface QuickModelSource {
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

export interface QuickModelChoice {
    readonly provider: AgentProvider;
    readonly model: string;
}

// A pinned selection on the wire: `${provider}:${modelId}`, the same key shape the model picker already mints
// for its entries (PickerEntry.key). An empty LIST of these ⇒ Auto.
export const quickModelKey = (choice: QuickModelChoice): string => `${choice.provider}:${choice.model}`;

/* Split on the FIRST colon only: a provider id never contains one and a model id might. Exported because the
 * key is what several surfaces carry a pinned pair AS: `autoFastModels` stores the same keys, the settings rows
 * read one back to draw the model they name, and a session composed from a pin travels as one (composeSession).
 *
 * `agentRunModels` is the one list that does NOT: an agent-run entry is an object, because it carries how the
 * model is to be run beside which model it is (AgentRunPinSchema), and a key with knobs spelled into it would
 * be a second encoding of the same thing for nobody's benefit. */
export const parsePinned = (pinned: string): QuickModelChoice | undefined => {
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
export const pinnedModelLabel = (choice: QuickModelChoice): string =>
    modelsFor(choice.provider).find((option) => option.value === choice.model)?.label ?? choice.model;

// The cheapest row a provider publishes, its whole catalog read from the cheap end. Undefined for a catalog
// that hasn't loaded yet, which is a real state: every provider serves a floor, but only once something has
// asked it.
const cheapestOf = (source: QuickModelSource): string | undefined => source.models.toSorted(compareCheapestFirst)[0];

// Where a provider's cheapest row sits on the shared tier scale, and therefore how well it answers the question
// this whole module asks. UNRANKED (-1) is a genuine last place: it means the id carries no tier word we know,
// so the row is the provider's base line rather than its budget one.
const tierOf = (model: string): number => tierRankOf(familyOf(model));

// PROVIDERS order, as the final tiebreak. Arbitrary, but the SAME arbitrary answer on every read, the property
// compareUnrankedModelIds exists to guarantee, and the one a default actually needs. An endpoint is in no fixed
// list, so it reads -1 and leads the tiebreak; unreachable in practice, since it can never tie on cost.
const providerOrder = (provider: AgentProvider): number => PROVIDERS.findIndex((entry) => entry.value === provider);

// How much a call on this provider costs at the margin. Every native provider declares an access kind; an
// endpoint declares none, and takes the metered rung, the conservative reading of a model API whose bill this
// repo cannot see, which keeps Auto from reaching for someone's paid gateway on its own initiative.
const costOf = (provider: AgentProvider): number => {
    const access = accessFor(provider);
    return access === undefined ? ACCESS_COST.key : ACCESS_COST[access.kind];
};

/* AUTO, every connected provider's cheapest row, best-first, as a ladder rather than a winner.
 *
 * Ranked on TIER FIRST, then cost. That order is the point of the feature: the helper exists to not be the
 * frontier model, so a free flagship is still the wrong tool, while a free Haiku-class row and a subscription
 * Haiku-class row differ only in whose quota they spend. Cost then breaks that tie towards the channel the user
 * is not paying per token for, and against the one they are.
 *
 * The whole ladder, not just its head, because the same ranking that picks the best answer also states the best
 * SECOND answer, and a sandbox with three accounts connected should not lose its commit messages for six hours
 * because one of them is spent. */
const autoLadder = (sources: readonly QuickModelSource[]): readonly QuickModelChoice[] =>
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

/* WHICH MODELS A QUICK HELPER MAY RUN, IN THE ORDER IT SHOULD TRY THEM, given what this sandbox has connected.
 * `pinned` is the stored setting: an ordered list of `${provider}:${model}` keys, empty for Auto.
 *
 * A pin only holds while its provider is READY: an account the user disconnected would otherwise sit at the
 * head of the chain failing on a credential error, when the sandbox can plainly still answer. Dropping it is
 * the same move the composer already makes when a live catalog stops offering the selected model.
 *
 * THE PINNED LIST IS THE WHOLE ANSWER whenever any of it survives that filter. Auto does NOT get appended
 * underneath, and that is deliberate: a user who writes down three models has said which accounts this feature
 * may spend, and quietly reaching for a fourth when all three are out is exactly the "spend an account they
 * were steering away from" failure a pin exists to prevent. When NONE of the pins is connected any more the
 * list has stopped saying anything about this sandbox, so Auto takes over rather than leaving a dead button.
 *
 * Empty when nothing is connected: the caller renders a control that says so, rather than a live button that
 * fails on click. */
export const resolveQuickModels = (sources: readonly QuickModelSource[], pinned: readonly string[]): readonly QuickModelChoice[] => {
    const ready = new Set(sources.filter((source) => source.ready).map((source) => source.provider));
    const requested = pinned.flatMap((key) => {
        // Taken verbatim, unvalidated against the catalog on purpose: the picker already offers a custom-id
        // escape hatch for a model a catalog hasn't caught up with, and second-guessing the user's own id here
        // would silently run a different model than the settings row names.
        const choice = parsePinned(key);
        return choice === undefined || !ready.has(choice.provider) ? [] : [choice];
    });
    // The same model twice would spend two attempts proving the same account is out, a real state, since the
    // list is edited by hand and Auto's ladder can rank a provider the user has also pinned.
    const chain = [...new Map(requested.map((choice) => [quickModelKey(choice), choice])).values()];
    return chain.length > 0 ? chain : autoLadder(sources);
};
