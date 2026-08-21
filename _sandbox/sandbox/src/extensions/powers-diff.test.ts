import { describe, expect, test } from "vitest";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { diffPowers } from "@intentic/extension-manifest";

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
        expect(diff.added).toContain("its UI calls the sandbox route POST /panels/*/start");
        expect(diff.added).toContain("its backend calls the daemon route GET /workspace/tree");
        expect(diff.added).toContain(`may badge the "Board" tile from any screen`);
        expect(diff.added).toContain("puts its shipped tools on the agent's PATH");
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
        expect(diff.removed).toEqual(["its UI calls the sandbox route GET /panels"]);
    });

    test("no installed manifest means everything is added: the install dialog's own vocabulary", () => {
        const diff = diffPowers(undefined, manifest());
        expect(diff.unchanged).toEqual([]);
        expect(diff.added).toContain(`a rail view "Board"`);
        expect(diff.added).toContain(`a background process "worker" (starts on boot)`);
        expect(diff.added).toContain("runs a UI bundle in your browser");
    });
});
