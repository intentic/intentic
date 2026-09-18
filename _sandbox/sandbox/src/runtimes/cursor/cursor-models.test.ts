import type { ModelListItem } from "@cursor/sdk";
import { EFFORT_TIERS } from "@intentic/sandbox-contract";
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

// Every Claude model Cursor vends lists `thinking` (false/true) ahead of `effort`, so the parameter list order below is
// the vendor's own, not a contrived one.
const claudeShape = model({
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    parameters: [
        { id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
        { id: "context", displayName: "Context", values: [{ value: "300k" }, { value: "1m" }] },
        {
            id: "effort",
            displayName: "Effort",
            values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }, { value: "max" }],
        },
        { id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
    ],
});

test("the thinking dial is found by what the vendor calls it, not by position", () => {
    for (const id of ["reasoning_effort", "thinking_level", "reasoning"]) {
        expect(effortParameterOf(model({ id: "m", parameters: [{ id, values: [{ value: "low" }] }] }))?.id).toBe(id);
    }
    expect(effortParameterOf(model({ id: "m", parameters: [{ id: "temperature", values: [{ value: "0.2" }] }] }))).toBeUndefined();
    expect(effortParameterOf(model({ id: "m", parameters: [{ id: "reasoning", values: [] }] }))).toBeUndefined();
});

test("an on/off switch is never the effort dial, however it is named", () => {
    expect(effortParameterOf(claudeShape)).toEqual({ id: "effort", values: ["low", "medium", "high", "xhigh", "max"] });
    // The whole ladder, not the switch: what the composer draws as rungs for Claude on Cursor.
    expect(toModel(claudeShape).efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // A model whose only named parameter IS the switch offers no scale at all, rather than a two-rung one.
    const switchOnly = model({ id: "claude-haiku-4-5", parameters: [{ id: "thinking", values: [{ value: "false" }, { value: "true" }] }] });
    expect(effortParameterOf(switchOnly)).toBeUndefined();
    expect(toModel(switchOnly).efforts).toBeUndefined();
});

test("a tier picked on the shared scale reaches the model as the effort Cursor published", () => {
    expect(paramsForEffort(claudeShape, "xhigh")).toEqual([{ id: "effort", value: "xhigh" }]);
    expect(paramsForEffort(claudeShape, "max")).toEqual([{ id: "effort", value: "max" }]);
});

// Cursor spells two rungs its own way; the picker labels and orders on one vocabulary, so the translation has to be
// total in both directions or a pick lands on the default variant instead of the rung the user chose.
test("Cursor's own spellings are published as tiers the shared scale names, and map back", () => {
    const gpt = model({
        id: "gpt-5.5",
        parameters: [
            { id: "context", values: [{ value: "272k" }, { value: "1m" }] },
            {
                id: "reasoning",
                values: [{ value: "none" }, { value: "low" }, { value: "medium" }, { value: "high" }, { value: "extra-high" }],
            },
        ],
    });
    expect(toModel(gpt).efforts).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(paramsForEffort(gpt, "minimal")).toEqual([{ id: "reasoning", value: "none" }]);
    expect(paramsForEffort(gpt, "xhigh")).toEqual([{ id: "reasoning", value: "extra-high" }]);
});

// The rule the tests above are instances of: nothing this module publishes may be a word the picker cannot rank or
// label, which is exactly how "false"/"true" reached the composer as two unlabelled rungs. Driven by every raw spelling
// seen across Cursor's live catalog, so a rung it adds is caught here rather than in the composer.
const CURSOR_SPELLINGS = ["none", "minimal", "low", "medium", "high", "xhigh", "extra-high", "max"];

test("no model publishes a tier outside the shared vocabulary", () => {
    const everySpelling = model({ id: "m", parameters: [{ id: "effort", values: CURSOR_SPELLINGS.map((value) => ({ value })) }] });
    const tiers = toModel(everySpelling).efforts ?? [];
    expect(tiers).toHaveLength(CURSOR_SPELLINGS.length);
    for (const tier of [...tiers, ...(toModel(claudeShape).efforts ?? []), ...(toModel(withEffort).efforts ?? [])]) {
        expect(EFFORT_TIERS).toContain(tier);
    }
});

test("an effort tier is matched against what THIS model published, case-insensitively", () => {
    expect(paramsForEffort(withEffort, "high")).toEqual([{ id: "reasoning_effort", value: "high" }]);
    expect(paramsForEffort(withEffort, "HIGH")).toEqual([{ id: "reasoning_effort", value: "high" }]);
});

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
    expect(paramsForEffort(withVariants, "minimal")).toEqual([{ id: "reasoning_effort", value: "high" }]);
    expect(paramsForEffort(withVariants, undefined)).toEqual([{ id: "reasoning_effort", value: "high" }]);
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
    expect(toModel(model({ id: "plain", displayName: "" }))).toEqual({ id: "plain", label: "plain" });
});

// Cursor's order is the vendor's own preference (unlike Codex's unordered /v1/models), so it passes through unranked,
// honoring the contract's order-is-meaningful rule.
test("the vendor's own order survives, and `auto` leads whenever it is offered", () => {
    const catalog = toCatalog([model({ id: "composer-2.5" }), model({ id: "auto" }), model({ id: "claude-opus-5" })]);
    expect(catalog.models.map((entry) => entry.id)).toEqual(["composer-2.5", "auto", "claude-opus-5"]);
    expect(catalog.default).toBe(CURSOR_DEFAULT_MODEL);
});

test("without `auto` the default is the head of the vendor's order", () => {
    expect(toCatalog([model({ id: "composer-2.5" }), model({ id: "claude-opus-5" })]).default).toBe("composer-2.5");
});

test("the seed floor is the one id that cannot be retired", () => {
    expect(SEED_CURSOR_MODELS).toEqual(["auto"]);
    expect(seedCatalog(SEED_CURSOR_MODELS)).toEqual({ models: [{ id: "auto", label: "Auto" }], default: "auto" });
    expect(seedCatalog(["composer-2.5"])).toEqual({ models: [{ id: "composer-2.5", label: "composer-2.5" }], default: "composer-2.5" });
});

test("even an empty list resolves to something sendable", () => {
    expect(toCatalog([]).default).toBe(CURSOR_DEFAULT_MODEL);
    expect(seedCatalog([]).default).toBe(CURSOR_DEFAULT_MODEL);
});
