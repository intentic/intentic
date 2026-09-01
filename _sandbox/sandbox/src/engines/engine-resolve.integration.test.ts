import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { activateVersion, engineVersionDir, forgetEngineStates, quarantineVersion } from "./engine-store.js";
import { forgetEngineResolution, resolveEngine } from "./engine-resolve.js";

/* THE ONE PROPERTY THAT MAKES TRACKING UPSTREAM SAFE TO SWITCH ON: every doubt resolves to the image's copy.
 *
 * This read sits directly in the turn path, so its failure mode is not a wrong answer on a card — it is a
 * sandbox that cannot start a turn. Each case below is a way the store can be wrong (never used, pointed at a
 * directory that is gone, pointed at a version this daemon has refused), and each has the same answer. */

const CURSOR_ENTRY = "dist/esm/index.js";

const installFixture = (version: string): void => {
    const pkgDir = join(engineVersionDir("cursor", version), "node_modules", "@cursor", "sdk");
    mkdirSync(join(pkgDir, "dist", "esm"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@cursor/sdk", exports: { ".": { import: `./${CURSOR_ENTRY}` } } }));
    writeFileSync(join(pkgDir, CURSOR_ENTRY), "export const Cursor = class {};\n");
};

beforeEach(() => {
    process.env["INTENTIC_ENGINES_DIR"] = mkdtempSync(join(tmpdir(), "engine-resolve-"));
    forgetEngineStates();
    forgetEngineResolution();
});

test("a store that has never been used answers with the image", async () => {
    const resolved = await resolveEngine("cursor");
    expect(resolved).toEqual({ id: "cursor", source: "image", paths: {} });
});

test("an active version answers with its own installed prefix", async () => {
    installFixture("1.0.28");
    await activateVersion("cursor", "1.0.28");
    forgetEngineResolution();

    const resolved = await resolveEngine("cursor");
    expect(resolved.source).toBe("store");
    expect(resolved.version).toBe("1.0.28");
    expect(resolved.paths.jsEntry).toBe(join(engineVersionDir("cursor", "1.0.28"), "node_modules", "@cursor", "sdk", CURSOR_ENTRY));
});

/* The pointer can outlive the directory: a GC on another daemon, an owner clearing space, a volume restored
 * from a snapshot older than the state file. Trusting it would fail every turn until somebody noticed. */
test("a pointer at a directory that is gone answers with the image", async () => {
    installFixture("1.0.28");
    await activateVersion("cursor", "1.0.28");
    rmSync(engineVersionDir("cursor", "1.0.28"), { recursive: true, force: true });
    forgetEngineResolution();

    expect((await resolveEngine("cursor")).source).toBe("image");
});

test("a version this daemon has refused is not served, whatever the pointer says", async () => {
    installFixture("1.0.28");
    await activateVersion("cursor", "1.0.28");
    await quarantineVersion("cursor", "1.0.28", "would not import", "2026-09-01T00:00:00.000Z");
    forgetEngineResolution();

    expect((await resolveEngine("cursor")).source).toBe("image");
});

/* The answer is cached for seconds, not for the process's life: an owner pressing Update has to reach the NEXT
 * turn. Within the window a burst of consumers costs one read, which is what the cache is for. */
test("the cached answer expires, so an update reaches the next turn", async () => {
    const start = 1_000_000;
    // Read once with an empty store, which is what a turn does before the owner presses anything.
    expect((await resolveEngine("cursor", start)).source).toBe("image");

    installFixture("1.0.28");
    await activateVersion("cursor", "1.0.28");

    // Inside the window the earlier answer stands: a burst of consumers within one turn costs one read.
    expect((await resolveEngine("cursor", start + 1_000)).source).toBe("image");
    // Past it, the pointer is re-read and the new version is what the next turn gets.
    expect((await resolveEngine("cursor", start + 6_000)).source).toBe("store");
});
