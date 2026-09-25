import { carryUnknown, readEntries, reemitQuarantined } from "./passthrough.js";

describe("carryUnknown", () => {
    test("a key parse stripped survives a write that did not set it, after the keys the write holds", () => {
        const raw = { theme: "dark", fromNewerBuild: { on: true } };
        const parsed = { theme: "dark" };
        expect(carryUnknown(raw, parsed, { theme: "light" })).toEqual({ theme: "light", fromNewerBuild: { on: true } });
    });

    test("a key this build knows and the write removed stays removed", () => {
        expect(carryUnknown({ a: 1, b: 2 }, { a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 });
    });

    test("nothing to carry answers the written value itself", () => {
        const updated = { a: 2 };
        expect(carryUnknown({ a: 1 }, { a: 1 }, updated)).toBe(updated);
    });

    test("nested objects carry by key", () => {
        const raw = { agent: { model: "m", effort: "high" } };
        expect(carryUnknown(raw, { agent: { model: "m" } }, { agent: { model: "n" } })).toEqual({ agent: { model: "n", effort: "high" } });
    });

    test("an object that switched union arm carries nothing across", () => {
        const raw = { trigger: { kind: "webhook", secretRef: "x" } };
        expect(carryUnknown(raw, { trigger: { kind: "webhook" } }, { trigger: { kind: "cron", at: "09:00" } })).toEqual({ trigger: { kind: "cron", at: "09:00" } });
    });

    test("array elements pair by reference when kept, by id when rebuilt, and not at all otherwise", () => {
        const rawEntries = [
            { id: "a", n: 1, extra: "a" },
            { id: "b", n: 2, extra: "b" },
        ];
        const parsedEntries = [
            { id: "a", n: 1 },
            { id: "b", n: 2 },
        ];
        const kept = parsedEntries[0];
        const updated = [kept, { id: "b", n: 3 }, { id: "c", n: 4 }];
        expect(carryUnknown(rawEntries, parsedEntries, updated)).toEqual([
            { id: "a", n: 1, extra: "a" },
            { id: "b", n: 3, extra: "b" },
            { id: "c", n: 4 },
        ]);
    });

    test("a parse that dropped elements cannot line raw up with parsed, so arrays carry nothing", () => {
        const updated = [{ id: "a" }];
        expect(carryUnknown([{ id: "a", x: 1 }, { broken: true }], [{ id: "a" }], updated)).toBe(updated);
    });
});

describe("entry quarantine", () => {
    const parseEntry = (entry: unknown): { id: string } | undefined =>
        typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string" ? { id: (entry as { id: string }).id } : undefined;

    test("readEntries keeps what it can read and remembers where the rest stood", () => {
        const read = readEntries([{ id: "a" }, { id: 7 }, { id: "b" }], parseEntry);
        expect(read.entries).toEqual([{ id: "a" }, { id: "b" }]);
        expect(read.quarantined).toEqual([{ index: 1, entry: { id: 7 } }]);
    });

    test("unreadable entries go back near where they stood, unless the write replaced their id", () => {
        const quarantined = [
            { index: 0, entry: { id: "new-kind", kind: "future" } },
            { index: 2, entry: { id: "b", kind: "future" } },
        ];
        expect(reemitQuarantined([{ id: "a" }, { id: "b" }], quarantined)).toEqual([{ id: "new-kind", kind: "future" }, { id: "a" }, { id: "b" }]);
        expect(reemitQuarantined([{ id: "a" }], [{ index: 5, entry: "garbage" }])).toEqual([{ id: "a" }, "garbage"]);
    });
});
