import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CURSOR_SDK_MISSING, cursorSdk, forgetCursorSdk } from "./cursor-sdk.js";

// Resolution has real stakes: pruned from every image, so getting it wrong stops the daemon entirely. A dev checkout
// with an empty store makes these cases the pack rung; the store rung is cursor-sdk-bootstrap.integration.test.ts's.

afterEach(() => {
    delete process.env["INTENTIC_CURSOR_SDK_DIR"];
    forgetCursorSdk();
});

test("a checkout with the dependency installed resolves it with no pack at all", async () => {
    // Empty directory: the pack rung misses so the fallback answers.
    process.env["INTENTIC_CURSOR_SDK_DIR"] = mkdtempSync(join(tmpdir(), "cursor-nopack-"));
    forgetCursorSdk();
    const sdk = await cursorSdk();
    expect(sdk?.Agent).toBeTypeOf("function");
    expect(sdk?.Cursor).toBeTypeOf("function");
});

// Entry is read off the manifest, never assembled from a path: require.resolve would honor require and load the CJS
// bundle, whose webpack exports are invisible to Node, surfacing as a TypeError deep in a turn, not "no pack".
test("a packed copy is loaded through its declared ESM entry, exports intact", async () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-pack-"));
    const pkgDir = join(root, "node_modules", "@cursor", "sdk");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "@cursor/sdk", version: "0.0.0-fixture", exports: { ".": { import: "./esm.js", require: "./cjs.js" } } }),
    );
    writeFileSync(join(pkgDir, "esm.js"), "export const Agent = 'esm';\nexport const Cursor = 'esm';\n");
    // The trap this guards: a resolver taking the require condition would load this instead and find nothing.
    writeFileSync(join(pkgDir, "cjs.js"), "module.exports = {};\n");

    process.env["INTENTIC_CURSOR_SDK_DIR"] = root;
    forgetCursorSdk();
    const sdk = (await cursorSdk()) as unknown as { Agent: string };
    expect(sdk.Agent).toBe("esm");
});

test("a manifest with only the legacy `module` field still resolves", async () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-pack-"));
    const pkgDir = join(root, "node_modules", "@cursor", "sdk");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@cursor/sdk", version: "0.0.0-fixture", module: "./esm.js" }));
    writeFileSync(join(pkgDir, "esm.js"), "export const Agent = 'legacy';\n");

    process.env["INTENTIC_CURSOR_SDK_DIR"] = root;
    forgetCursorSdk();
    expect(((await cursorSdk()) as unknown as { Agent: string }).Agent).toBe("legacy");
});

// No declared ESM entry means an unusable copy; answering with it would turn a missing pack into a throw at turn time.
// Falls through to the checkout's own copy, which is why this expects a real SDK, not undefined.
test("a packed copy that declares no ESM entry falls through rather than half-loading", async () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-pack-"));
    const pkgDir = join(root, "node_modules", "@cursor", "sdk");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@cursor/sdk", version: "0.0.0-fixture", main: "./cjs.js" }));
    writeFileSync(join(pkgDir, "cjs.js"), "module.exports = {};\n");

    process.env["INTENTIC_CURSOR_SDK_DIR"] = root;
    forgetCursorSdk();
    expect((await cursorSdk())?.Agent).toBeTypeOf("function");
});

// "rebuild" is load-bearing: a surface routes on this word, so it's asserted rather than left to survive a rewording.
test("the missing-runtime message points at a rebuild", () => {
    expect(CURSOR_SDK_MISSING).toContain("rebuild");
});
