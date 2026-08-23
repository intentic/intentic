import type { ModelListItem } from "@cursor/sdk";
import { expect, test } from "vitest";
import {
    CURSOR_DEFAULT_MODEL,
    effortParameterOf,
    paramsForEffort,
    SEED_CURSOR_MODELS,
    seedCatalog,
    selectionFor,
    toCatalog,
    toModel,
} from "./cursor-models.js";

const model = (over: Partial<ModelListItem> & { id: string }): ModelListItem => ({ displayName: over.id, ...over });

const withEffort = model({
    id: "composer-2.5",
    displayName: "Composer 2.5",
    description: "Cursor's own frontier model.",
    parameters: [{ id: "reasoning_effort", displayName: "Reasoning", values: [{ value: "low" }, { value: "medium" }, { value: "high" }] }],
});

test("the thinking dial is found by what the vendor calls it, not by position", () => {
    // Three spellings this family of APIs has actually used, all recognised, so a rename upstream does not
    // silently drop the effort control.
    for (const id of ["reasoning_effort", "thinking_level", "reasoning"]) {
        expect(effortParameterOf(model({ id: "m", parameters: [{ id, values: [{ value: "low" }] }] }))?.id).toBe(id);
    }
    // A tunable that is not the dial is left alone rather than guessed at.
    expect(effortParameterOf(model({ id: "m", parameters: [{ id: "temperature", values: [{ value: "0.2" }] }] }))).toBeUndefined();
    // A dial with no published values is not a dial: offering an empty scale would be a control that does nothing.
    expect(effortParameterOf(model({ id: "m", parameters: [{ id: "reasoning", values: [] }] }))).toBeUndefined();
});

test("an effort tier is matched against what THIS model published, case-insensitively", () => {
    expect(paramsForEffort(withEffort, "high")).toEqual([{ id: "reasoning_effort", value: "high" }]);
    expect(paramsForEffort(withEffort, "HIGH")).toEqual([{ id: "reasoning_effort", value: "high" }]);
});

/* `max` is intentic's own top tier and no non-Claude scale has it. Read as "the top of whatever this model
 * offers" rather than dropped: somebody who picked the top of the scale meant the top of the scale, and
 * sending our vocabulary verbatim would be a refusal from the backend with a confusing message. */
test("the shared scale's top tier lands on the model's own highest", () => {
    expect(paramsForEffort(withEffort, "max")).toEqual([{ id: "reasoning_effort", value: "high" }]);
});

test("an untranslatable tier falls back to the variant Cursor itself marks default", () => {
    const withVariants = model({
        id: "auto",
        parameters: [{ id: "reasoning_effort", values: [{ value: "low" }, { value: "high" }] }],
        variants: [
            { params: [{ id: "reasoning_effort", value: "low" }], displayName: "Fast" },
            { params: [{ id: "reasoning_effort", value: "high" }], displayName: "Thorough", isDefault: true },
        ],
    });
    // "minimal" is in intentic's scale and not in this model's, so an unset control is the honest reading.
    expect(paramsForEffort(withVariants, "minimal")).toEqual([{ id: "reasoning_effort", value: "high" }]);
    expect(paramsForEffort(withVariants, undefined)).toEqual([{ id: "reasoning_effort", value: "high" }]);
    // Nothing to fall back to ⇒ no params at all, rather than an invented pair.
    expect(paramsForEffort(model({ id: "bare" }), "high")).toEqual([]);
});

test("a selection carries params only when there are any", () => {
    expect(selectionFor(withEffort, "low")).toEqual({ id: "composer-2.5", params: [{ id: "reasoning_effort", value: "low" }] });
    expect(selectionFor(model({ id: "bare" }), "low")).toEqual({ id: "bare" });
});

test("a catalog row publishes what Cursor said and invents nothing where it was silent", () => {
    expect(toModel(withEffort)).toEqual({
        id: "composer-2.5",
        label: "Composer 2.5",
        description: "Cursor's own frontier model.",
        efforts: ["low", "medium", "high"],
    });
    // No description and no dial ⇒ a label-only row. Absent fields, never empty ones: the contract reads an
    // absent `efforts` as "use your own defaults" and an empty one as "this model accepts no tiers".
    expect(toModel(model({ id: "plain", displayName: "" }))).toEqual({ id: "plain", label: "plain" });
});

/* Cursor's order IS the vendor's preference, unlike the OpenAI-compatible /v1/models the Codex catalog reads
 * (an unordered set that something has to rank). So it is passed through, and the contract's "a provider's
 * order is meaningful and is not re-ranked locally" is honoured rather than worked around. */
test("the vendor's own order survives, and `auto` leads whenever it is offered", () => {
    const catalog = toCatalog([model({ id: "composer-2.5" }), model({ id: "auto" }), model({ id: "claude-opus-5" })]);
    expect(catalog.models.map((entry) => entry.id)).toEqual(["composer-2.5", "auto", "claude-opus-5"]);
    // Not the head of the list: `auto` is Cursor's own router and the one id that cannot go stale.
    expect(catalog.default).toBe(CURSOR_DEFAULT_MODEL);
});

test("without `auto` the default is the head of the vendor's order", () => {
    expect(toCatalog([model({ id: "composer-2.5" }), model({ id: "claude-opus-5" })]).default).toBe("composer-2.5");
});

/* The floor is ONE id on purpose. A longer seed would be a list of guesses whose only effect, on the day one is
 * retired, is a picker offering a row whose every turn fails. */
test("the seed floor is the one id that cannot be retired", () => {
    expect(SEED_CURSOR_MODELS).toEqual(["auto"]);
    expect(seedCatalog(SEED_CURSOR_MODELS)).toEqual({ models: [{ id: "auto", label: "Auto" }], default: "auto" });
    // A persisted rung carries ids and nothing else, so its rows are label-only rather than fabricated.
    expect(seedCatalog(["composer-2.5"])).toEqual({ models: [{ id: "composer-2.5", label: "composer-2.5" }], default: "composer-2.5" });
});

// An empty list can only be reached by a caller that has one, and it must still resolve a model: the SDK
// requires one for a local agent and has no default of its own to fall back on.
test("even an empty list resolves to something sendable", () => {
    expect(toCatalog([]).default).toBe(CURSOR_DEFAULT_MODEL);
    expect(seedCatalog([]).default).toBe(CURSOR_DEFAULT_MODEL);
});
