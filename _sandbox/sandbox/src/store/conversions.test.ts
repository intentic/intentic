import { at, ConversionError, convertDocument, drop, fold, mapValue, pinDefault, rename, retireEntries, retype, transform, type JsonObject } from "./conversions.js";

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

describe("rename", () => {
    test("moves the value to the new key in the old key's place, and settles", () => {
        const { value, changes } = convertDocument([rename("agentRunModel", "agentRunModels")], "object", { a: 1, agentRunModel: "x", b: 2 });
        expect(value).toEqual({ a: 1, agentRunModels: "x", b: 2 });
        expect(Object.keys(value as JsonObject)).toEqual(["a", "agentRunModels", "b"]);
        expect(changes).toEqual([{ conversion: "renames agentRunModel to agentRunModels", at: "" }]);
    });

    test("with both names present the current one wins and the older value is named in the change", () => {
        const { value, changes } = convertDocument([rename("old", "new")], "object", { old: "stale", new: "kept" });
        expect(value).toEqual({ new: "kept" });
        expect(changes).toEqual([{ conversion: "renames old to new", at: "", detail: 'kept new; old held "stale"' }]);
    });

    test("both names holding the same value (a grace window's double write) settle with nothing to report", () => {
        expect(convertDocument([rename("old", "new")], "object", { old: [1], new: [1] })).toEqual({ value: { new: [1] }, changes: [] });
    });

    test("a document already past it comes back as the same object", () => {
        const document = { new: 1 };
        const { value, changes } = convertDocument([rename("old", "new")], "object", document);
        expect(value).toBe(document);
        expect(changes).toEqual([]);
    });
});

describe("the other conversions", () => {
    test("drop removes a retired key and records what it held", () => {
        expect(convertDocument([drop("commandRules")], "object", { commandRules: [1], keep: true })).toEqual({
            value: { keep: true },
            changes: [{ conversion: "drops commandRules", at: "", detail: "it held [1]" }],
        });
    });

    test("retype converts only the old representation", () => {
        const pins = retype("agentRunModels", isStringArray, (ids) => ids.map((model) => ({ model })));
        expect(convertDocument([pins], "object", { agentRunModels: ["a", "b"] }).value).toEqual({ agentRunModels: [{ model: "a" }, { model: "b" }] });
        const converted = { agentRunModels: [{ model: "a" }] };
        expect(convertDocument([pins], "object", converted).value).toBe(converted);
    });

    test("mapValue replaces an old value and refuses a mapping that would map its own output again", () => {
        expect(convertDocument([mapValue("personaRouting", { off: false, auto: true })], "object", { personaRouting: "auto" }).value).toEqual({
            personaRouting: true,
        });
        expect(() => mapValue("mode", { a: "b", b: "c" })).toThrow("mapValue(mode) maps onto its own keys (b), so it would not settle");
    });

    test("pinDefault fills an absent key and leaves a present one alone", () => {
        expect(convertDocument([pinDefault("strict", false)], "object", {}).value).toEqual({ strict: false });
        expect(convertDocument([pinDefault("strict", false)], "object", { strict: true }).value).toEqual({ strict: true });
    });

    test("transform runs only where its guard recognizes the old shape", () => {
        const ladder = transform(
            "turns agent, harness and model into a models ladder",
            (value): value is JsonObject & { model: string } => typeof value["model"] === "string" && !Object.hasOwn(value, "models"),
            ({ model, ...rest }) => ({ ...rest, models: [{ model }] }),
        );
        expect(convertDocument([ladder], "object", { id: "a", model: "m" }).value).toEqual({ id: "a", models: [{ model: "m" }] });
    });

    test("at reaches nested objects, with * over every element", () => {
        const { value, changes } = convertDocument([at("trigger", drop("token"))], "entries", [
            { id: "a", trigger: { kind: "webhook", token: "t" } },
            { id: "b", trigger: { kind: "cron" } },
        ]);
        expect(value).toEqual([
            { id: "a", trigger: { kind: "webhook" } },
            { id: "b", trigger: { kind: "cron" } },
        ]);
        expect(changes).toEqual([{ conversion: "drops token", at: "[0].trigger", detail: 'it held "t"' }]);
        expect(convertDocument([at("steps.*", rename("x", "y"))], "object", { steps: [{ x: 1 }, { y: 2 }] }).value).toEqual({ steps: [{ y: 1 }, { y: 2 }] });
    });
});

describe("fold and retireEntries", () => {
    const ladder = fold("folds agent and model into a ladder", {
        from: ["agent", "model"],
        into: "models",
        applies: (entry) => typeof entry["model"] === "string" && !Object.hasOwn(entry, "models"),
        convert: ({ agent, model }) => [{ provider: typeof agent === "string" ? agent : "claude", model }],
    });

    test("fold replaces the old keys with one, where the first of them stood", () => {
        const { value } = convertDocument([ladder], "object", { id: "a", agent: "codex", model: "m", enabled: true });
        expect(value).toEqual({ id: "a", models: [{ provider: "codex", model: "m" }], enabled: true });
        expect(Object.keys(value as JsonObject)).toEqual(["id", "models", "enabled"]);
    });

    test("fold leaves a document it does not apply to alone, by reference", () => {
        const unnamed = { id: "a", agent: "codex" };
        expect(convertDocument([ladder], "object", unnamed).value).toBe(unnamed);
    });

    const withdrawn = retireEntries("retires withdrawn kinds", (entry): entry is { kind: "service" } => (entry as { kind?: unknown } | null)?.kind === "service");

    test("retireEntries removes withdrawn entries from an entry list and records each", () => {
        const { value, changes } = convertDocument([withdrawn], "entries", [{ id: "a", kind: "cli" }, { id: "b", kind: "service" }]);
        expect(value).toEqual([{ id: "a", kind: "cli" }]);
        expect(changes).toEqual([{ conversion: "retires withdrawn kinds", at: "[1]", detail: '{"id":"b","kind":"service"}' }]);
    });

    test("retireEntries reaches a nested list through at, and a keyed record by key", () => {
        expect(convertDocument([at("rules", withdrawn)], "object", { rules: [{ kind: "service" }, { kind: "cron" }] }).value).toEqual({ rules: [{ kind: "cron" }] });
        expect(convertDocument([withdrawn], "record", { a: { kind: "service" }, b: { kind: "cli" } }).value).toEqual({ b: { kind: "cli" } });
    });
});

describe("granularity", () => {
    test("entries converts each object element and leaves the rest untouched", () => {
        const untouched = { id: "b", y: 1 };
        const { value } = convertDocument([rename("x", "y")], "entries", [{ id: "a", x: 1 }, untouched, "not an object"]);
        expect(value).toEqual([{ id: "a", y: 1 }, untouched, "not an object"]);
        expect((value as unknown[])[1]).toBe(untouched);
    });

    test("record converts each value of a keyed object", () => {
        expect(convertDocument([rename("x", "y")], "record", { a: { x: 1 }, b: { y: 2 } }).value).toEqual({ a: { y: 1 }, b: { y: 2 } });
    });

    test("a document of the wrong kind for its granularity comes back as it was", () => {
        const document = { not: "an array" };
        expect(convertDocument([rename("x", "y")], "entries", document).value).toBe(document);
    });
});

describe("failures", () => {
    test("a conversion that throws is named, not the last one that reported a change", () => {
        const boom = retype(
            "b",
            (value): value is number => typeof value === "number",
            () => {
                throw new Error("bad data");
            },
            "converts b",
        );
        const run = (): unknown => convertDocument([rename("a", "z"), boom], "object", { a: 1, b: 2 });
        expect(run).toThrow(ConversionError);
        expect(run).toThrow('conversion "converts b" failed: bad data');
    });

    test("a conversion that does not settle on its own output fails the first read in a dev build", () => {
        const counter = transform(
            "counts reads",
            (value): value is JsonObject & { n: number } => typeof value["n"] === "number",
            ({ n }) => ({ n: n + 1 }),
        );
        expect(() => convertDocument([counter], "object", { n: 1 })).toThrow('conversion "counts reads" failed: it changed its own output, so it would run on every read');
    });
});
