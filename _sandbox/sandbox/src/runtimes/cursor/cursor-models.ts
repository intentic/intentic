import type { ModelListItem, ModelParameterValue, ModelSelection } from "@cursor/sdk";
import type { Model } from "@intentic/sandbox-contract";

// Pure functions over Cursor.models.list()'s response, kept apart from the fetching service (cursor-catalog.ts) so the
// mapping is testable without a credential. Nothing here is curated: a model Cursor adds tomorrow reaches the picker
// with no code change.

// One id on purpose: auto always exists and can't be retired, unlike a named model a longer seed might guess wrong.
export const SEED_CURSOR_MODELS: readonly string[] = ["auto"];

// Cursor's own default when nothing is named; the SDK requires one, and this is the id, same as the seed above.
export const CURSOR_DEFAULT_MODEL = "auto";

// Matches the thinking dial by name (reasoning/effort/think), loosely: Cursor's vocabulary varies per model.
const EFFORT_PARAM = /reason|effort|think/iu;

export const effortParameterOf = (item: ModelListItem): { id: string; values: string[] } | undefined => {
    const parameter = (item.parameters ?? []).find((entry) => EFFORT_PARAM.test(entry.id));
    if (parameter === undefined || parameter.values.length === 0) {
        return undefined;
    }
    return { id: parameter.id, values: parameter.values.map((value) => value.value) };
};

// Matches the tier against what this model published, case-insensitively; an unmatched one falls back to Cursor's own
// default variant. "max" has no equivalent outside Claude's scale, so it reads as this model's highest instead of
// dropped.
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
        // Published order is lowest to highest in every scale of this shape, so the last entry is this model's highest.
        const highest = dial.values.at(-1);
        return highest === undefined ? fallback : [{ id: dial.id, value: highest }];
    }
    return fallback;
};

// The concrete selection a turn sends: the resolved id plus whatever the effort tier maps to on this model.
export const selectionFor = (item: ModelListItem, effort: string | undefined): ModelSelection => {
    const params = paramsForEffort(item, effort);
    return { id: item.id, ...(params.length > 0 ? { params } : {}) };
};

// Nothing invented where Cursor is silent. No badges: reasoning/fast mean something specific in Anthropic's catalog
// (fast also gates a first-party feature), and a Cursor variant called "Fast" isn't that.
export const toModel = (item: ModelListItem): Model => {
    const dial = effortParameterOf(item);
    return {
        id: item.id,
        label: item.displayName !== "" ? item.displayName : item.id,
        ...(item.description !== undefined && item.description !== "" ? { description: item.description } : {}),
        ...(dial !== undefined ? { efforts: dial.values } : {}),
    };
};

// Kept in Cursor's own order, never re-sorted: unlike Codex's unordered /v1/models, this is a curated surface whose
// order is the vendor's preference. Default is auto whenever offered (the router, never stale), else the order's head.
export const toCatalog = (items: readonly ModelListItem[]): { models: Model[]; default: string } => {
    const models = items.map(toModel);
    const auto = models.find((model) => model.id === CURSOR_DEFAULT_MODEL);
    return { models, default: (auto ?? models[0])?.id ?? CURSOR_DEFAULT_MODEL };
};

// Same shape as the floor above, label-only: nothing is known about a seeded id beyond its name.
export const seedCatalog = (ids: readonly string[]): { models: Model[]; default: string } => {
    const models = ids.map((id) => ({ id, label: id === CURSOR_DEFAULT_MODEL ? "Auto" : id }));
    return { models, default: models[0]?.id ?? CURSOR_DEFAULT_MODEL };
};
