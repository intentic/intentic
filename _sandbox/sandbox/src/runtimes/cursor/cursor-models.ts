import type { ModelListItem, ModelParameterValue, ModelSelection } from "@cursor/sdk";
import type { Model } from "@intentic/sandbox-contract";

/* CURSOR'S CATALOG, TRANSLATED. Pure functions over what `Cursor.models.list()` hands back, kept apart from the
 * service that fetches it (cursor-catalog.ts) so the mapping is testable without a credential.
 *
 * Cursor publishes more per model than most: a display name, a description, and either a set of tunable
 * PARAMETERS or a set of named VARIANTS over them. None of it is curated in this repo, the house rule, so a
 * model Cursor adds tomorrow reaches the picker with no code change here. */

/* THE ONE ID FLOOR, and it is one id on purpose. `auto` is Cursor's own router: it always exists, it is what
 * the product itself defaults to, and it cannot be retired out from under a sandbox the way a named model can.
 * A longer seed would be a list of guesses whose only effect, on the day one of them is retired, is a picker
 * offering a row whose every turn fails.
 *
 * This floor is reached only before the first live load, or when discovery cannot answer at all. The moment a
 * key can enumerate, the real list replaces it wholesale. */
export const SEED_CURSOR_MODELS: readonly string[] = ["auto"];

// Cursor's own default when a caller names nothing. The SDK REQUIRES a model for a local agent, so the daemon
// always names one; this is which one it names, and why the seed above is the same id.
export const CURSOR_DEFAULT_MODEL = "auto";

/* WHICH TUNABLE IS THE THINKING DIAL. Cursor names its parameters per model rather than publishing one scale,
 * so the dial is recognised by what it is called instead of by a position in a list. Matched loosely and
 * case-insensitively because the vocabulary is the vendor's to change ("reasoning", "reasoning_effort",
 * "thinking_level" have all been seen in this family of APIs), and an unmatched parameter is simply left alone
 * rather than guessed at, a model whose only tunable we do not understand offers no effort control and says so.
 */
const EFFORT_PARAM = /reason|effort|think/iu;

export const effortParameterOf = (item: ModelListItem): { id: string; values: string[] } | undefined => {
    const parameter = (item.parameters ?? []).find((entry) => EFFORT_PARAM.test(entry.id));
    if (parameter === undefined || parameter.values.length === 0) {
        return undefined;
    }
    return { id: parameter.id, values: parameter.values.map((value) => value.value) };
};

/* The params a selection should carry for a requested effort tier.
 *
 * THREE WAYS TO GET IT WRONG AND ONE TO GET IT RIGHT. Sending a tier the model does not publish is a request
 * the backend refuses; sending nothing loses a control the user set; and sending our own vocabulary
 * ("max", the Claude scale's top tier) at a model that names its levels differently is the same refusal with
 * a more confusing message. So the tier is matched against what THIS model published, case-insensitively, and
 * an unmatched one falls back to the variant Cursor itself marks default, which is what an unset control means.
 *
 * `max` gets one extra hop: it is intentic's top tier and no non-Claude scale has it, so it is read as a
 * request for whatever this model calls its highest, rather than dropped. That is a judgement, and it is the
 * kind worth making: someone who picked the top of the scale meant the top of the scale. */
export const paramsForEffort = (item: ModelListItem, effort: string | undefined): ModelParameterValue[] => {
    const dial = effortParameterOf(item);
    const fallback = (item.variants ?? []).find((variant) => variant.isDefault)?.params ?? [];
    if (dial === undefined || effort === undefined || effort === "") {
        return fallback;
    }
    const exact = dial.values.find((value) => value.toLowerCase() === effort.toLowerCase());
    if (exact !== undefined) {
        return [{ id: dial.id, value: exact }];
    }
    if (effort === "max") {
        // The published order is the vendor's own, lowest to highest in every scale of this shape, so the last
        // entry is "as much as this model does".
        const highest = dial.values.at(-1);
        return highest === undefined ? fallback : [{ id: dial.id, value: highest }];
    }
    return fallback;
};

// The concrete selection a turn sends: the id it resolved plus whatever the effort tier maps to on that model.
export const selectionFor = (item: ModelListItem, effort: string | undefined): ModelSelection => {
    const params = paramsForEffort(item, effort);
    return { id: item.id, ...(params.length > 0 ? { params } : {}) };
};

/* One catalog row, in the shape every provider's picker already reads. `label` is Cursor's own display name,
 * `description` its own words, `efforts` the dial's published levels; nothing is invented where Cursor is
 * silent, which is what keeps a row honest rather than padded.
 *
 * No `badges`. Those two flags mean something specific here (`reasoning` and `fast` as Anthropic's catalog
 * reports them, and `fast` additionally gates a first-party-only feature), and mapping a Cursor variant called
 * "Fast" onto the badge that unlocks Anthropic's fast tier would be claiming something untrue about the route. */
export const toModel = (item: ModelListItem): Model => {
    const dial = effortParameterOf(item);
    return {
        id: item.id,
        label: item.displayName !== "" ? item.displayName : item.id,
        ...(item.description !== undefined && item.description !== "" ? { description: item.description } : {}),
        ...(dial !== undefined ? { efforts: dial.values } : {}),
    };
};

/* The rows a live list becomes, in CURSOR'S OWN ORDER. Deliberately not re-sorted, which is the opposite of
 * what the Codex catalog does, and the difference is real rather than stylistic: an OpenAI-compatible
 * /v1/models publishes an unordered SET (so something has to impose a ranking, and this repo's model-order.ts
 * does), while `Cursor.models.list()` is a curated product surface whose order IS the vendor's preference. The
 * contract already says a provider's order is meaningful and is not re-ranked locally; this is a provider that
 * has one.
 *
 * The DEFAULT is `auto` whenever Cursor offers it, because it is the router the product itself leads with and
 * the one id that cannot go stale. Otherwise the head of the vendor's own order, which is the same question
 * answered by the same authority. */
export const toCatalog = (items: readonly ModelListItem[]): { models: Model[]; default: string } => {
    const models = items.map(toModel);
    const auto = models.find((model) => model.id === CURSOR_DEFAULT_MODEL);
    return { models, default: (auto ?? models[0])?.id ?? CURSOR_DEFAULT_MODEL };
};

// The floor as the same shape, for the rungs below discovery. Label-only rows: nothing is known about a seeded
// id beyond its name, and saying so beats inventing a description for it.
export const seedCatalog = (ids: readonly string[]): { models: Model[]; default: string } => {
    const models = ids.map((id) => ({ id, label: id === CURSOR_DEFAULT_MODEL ? "Auto" : id }));
    return { models, default: models[0]?.id ?? CURSOR_DEFAULT_MODEL };
};
