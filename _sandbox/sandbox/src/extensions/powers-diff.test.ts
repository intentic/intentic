import { describe, expect, test } from "vitest";
import { ExtensionManifestSchema, diffPowers } from "@intentic/extension-manifest";

const manifest = (overrides: object = {}) =>
    ExtensionManifestSchema.parse({
        publisher: "acme",
        name: "demo",
        version: "1.0.0",
        engines: { intentic: "^0.1" },
        entry: "dist/extension.js",
        permissions: { sandbox: ["GET /panels"] },
        contributes: {
            views: [{ id: "board", label: "Board", surface: "rail" }],
            processes: [{ name: "worker", command: "node worker.js", autoStart: true }],
        },
        ...overrides,
    });

describe("diffPowers", () => {
    test("identical manifests ask for nothing new: the one-click case", () => {
        const diff = diffPowers(manifest(), manifest());
        expect(diff.added).toEqual([]);
        expect(diff.removed).toEqual([]);
        expect(diff.unchanged.length).toBeGreaterThan(0);
    });

    test("a grown manifest's additions are named in plain sentences, per power", () => {
        const grown = manifest({
            permissions: { sandbox: ["GET /panels", "POST /panels/*/start"], daemon: ["GET /workspace/tree"] },
            contributes: {
                views: [{ id: "board", label: "Board", surface: "rail", badge: true }],
                processes: [{ name: "worker", command: "node worker.js", autoStart: true }],
                bin: "bin",
            },
        });
        const diff = diffPowers(manifest(), grown);
        expect(diff.added.some((line) => line.includes("POST /panels/*/start"))).toBe(true);
        expect(diff.added.some((line) => line.includes("GET /workspace/tree"))).toBe(true);
        expect(diff.added.some((line) => line.includes(`"Board"`))).toBe(true);
        expect(diff.added.some((line) => line.includes("PATH"))).toBe(true);
        expect(diff.removed).toEqual([]);
        // The view itself is unchanged: only its badge right is new.
        expect(diff.unchanged).toContain(`a rail view "Board"`);
    });

    test("a power's internals moving keeps its key: the sha pin answers for code, this answers for reach", () => {
        const retuned = manifest({
            contributes: { views: [{ id: "board", label: "Board", surface: "rail" }], processes: [{ name: "worker", command: "node other.js" }] },
        });
        const diff = diffPowers(manifest(), retuned);
        // Same process name, different command and autoStart: not an addition, and the label change surfaces
        // as the shrunken form only where the SET changed: here it did not.
        expect(diff.added).toEqual([]);
        expect(diff.removed).toEqual([]);
    });

    test("a shrunk manifest reports what it stopped asking for", () => {
        const shrunk = manifest({ permissions: undefined });
        const diff = diffPowers(manifest(), shrunk);
        expect(diff.removed).toEqual([expect.stringContaining("GET /panels")]);
    });

    test("no installed manifest means everything is added: the install dialog's own vocabulary", () => {
        const diff = diffPowers(undefined, manifest());
        expect(diff.unchanged).toEqual([]);
        expect(diff.added.some((line) => line.includes(`"Board"`))).toBe(true);
        expect(diff.added.some((line) => line.includes(`"worker"`))).toBe(true);
        expect(diff.added.length).toBeGreaterThan(diff.unchanged.length);
    });
});
