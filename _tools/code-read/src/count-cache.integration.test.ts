import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CountStore, keptLineStat, readingId, readingIdOf } from "./count-cache.js";
import { grammars } from "./grammars.js";

const memoryStore = (): CountStore & { readonly rows: Map<string, { additions: number | null; deletions: number | null }> } => {
    const rows = new Map<string, { additions: number | null; deletions: number | null }>();
    return { rows, get: (key) => rows.get(key), put: (key, additions, deletions) => rows.set(key, { additions, deletions }) && undefined };
};

describe("readingIdOf", () => {
    it("moves with a file at any depth of the build and with a dependency's installed version", () => {
        const root = mkdtempSync(join(tmpdir(), "reading-id-"));
        try {
            mkdirSync(join(root, "dist", "nested"), { recursive: true });
            mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
            writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", dependencies: { dep: "1" } }));
            writeFileSync(join(root, "node_modules", "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
            writeFileSync(join(root, "dist", "index.js"), "export const a = 1;\n");
            writeFileSync(join(root, "dist", "nested", "walk.js"), "export const b = 1;\n");
            const id = (): string => readingIdOf(join(root, "dist"), join(root, "package.json"));
            const first = id();
            expect(id()).toBe(first);
            writeFileSync(join(root, "dist", "nested", "walk.js"), "export const b = 2;\n");
            const nested = id();
            expect(nested).not.toBe(first);
            writeFileSync(join(root, "node_modules", "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.1" }));
            expect(id()).not.toBe(nested);
            // A suite or a declaration beside the build is not code that reads.
            writeFileSync(join(root, "dist", "index.d.ts"), "export declare const a: number;\n");
            writeFileSync(join(root, "dist", "index.test.ts"), "test(`x`, () => {});\n");
            expect(id()).toBe(readingIdOf(join(root, "dist"), join(root, "package.json")));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("is a sha256 of this build", () => {
        expect(readingId()).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("keptLineStat", () => {
    const before = "export const a = 1;\n";
    const after = "export const a = 1;\nexport const b = 2; // why\n";

    it("counts once and answers the same pair from the store after", async () => {
        const store = memoryStore();
        expect(await keptLineStat(store, before, after, "src/a.ts", grammars)).toEqual({ additions: 1, deletions: 0 });
        expect(store.rows.size).toBe(1);
        const [key] = [...store.rows.keys()];
        store.rows.set(key!, { additions: 7, deletions: 3 });
        expect(await keptLineStat(store, before, after, "src/a.ts", grammars)).toEqual({ additions: 7, deletions: 3 });
    });

    it("keeps nothing for a path with no grammar, and counts without a store", async () => {
        const store = memoryStore();
        expect(await keptLineStat(store, "one", "two", "notes.unknownext", grammars)).toBeUndefined();
        expect(store.rows.size).toBe(0);
        expect(await keptLineStat(undefined, before, after, "src/a.ts", grammars)).toEqual({ additions: 1, deletions: 0 });
    });
});
