import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { activateVersion, engineVersionDir, forgetEngineStates, quarantineVersion } from "./engine-store.js";
import { forgetEngineResolution, resolveEngine } from "./engine-resolve.js";

// Every doubt resolves to the image's copy: an unused, missing, or quarantined store entry all fall back the same way,
// since this read sits in the turn path.

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

// resolveEngine takes an explicit clock argument so the cache TTL can be crossed without a real wait.
test("the cached answer expires, so an update reaches the next turn", async () => {
    const start = 1_000_000;
    expect((await resolveEngine("cursor", start)).source).toBe("image");

    installFixture("1.0.28");
    await activateVersion("cursor", "1.0.28");

    expect((await resolveEngine("cursor", start + 1_000)).source).toBe("image");
    expect((await resolveEngine("cursor", start + 6_000)).source).toBe("store");
});
