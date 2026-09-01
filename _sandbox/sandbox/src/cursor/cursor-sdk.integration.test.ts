import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CURSOR_SDK_MISSING, cursorSdk, forgetCursorSdk } from "./cursor-sdk.js";

/* HOW THE RUNTIME IS FOUND, which on this provider is a question with real consequences: `@cursor/sdk` is
 * pruned out of every published image for licence reasons, so the daemon has to boot without it and find it
 * later, in the engine store or in a prefix a pack installed. Getting this wrong does not degrade Cursor — it
 * stops the daemon starting at all, for everyone, whether or not they use Cursor.
 *
 * This suite runs in a DEV CHECKOUT, where the module is a real dependency, so the fallback rung is genuinely
 * exercised and the pack rung is exercised against a fixture. The STORE rung is exercised by
 * cursor-sdk-bootstrap.integration.test.ts, which is where an install puts a version there; here the store is
 * empty by construction (src/testing/engine-fence.ts), which is what makes these cases about the pack. */

afterEach(() => {
    delete process.env["INTENTIC_CURSOR_SDK_DIR"];
    forgetCursorSdk();
});

test("a checkout with the dependency installed resolves it with no pack at all", async () => {
    // Pointed at a directory containing nothing, so the pack rung misses and the fallback is what answers.
    process.env["INTENTIC_CURSOR_SDK_DIR"] = mkdtempSync(join(tmpdir(), "cursor-nopack-"));
    forgetCursorSdk();
    const sdk = await cursorSdk();
    expect(sdk?.Agent).toBeTypeOf("function");
    expect(sdk?.Cursor).toBeTypeOf("function");
});

/* THE ENTRY IS READ OFF THE PACKAGE'S OWN MANIFEST, never assembled from a path. `require.resolve` would honour
 * the `require` condition and hand back the CJS bundle, whose exports webpack installs with
 * `Object.defineProperty` — invisible to Node's CJS named-export detection, so `Agent` and `Cursor` would both
 * be undefined and the failure would surface as a TypeError deep inside a turn rather than as "no pack". */
test("a packed copy is loaded through its declared ESM entry, exports intact", async () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-pack-"));
    const pkgDir = join(root, "node_modules", "@cursor", "sdk");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "@cursor/sdk", version: "0.0.0-fixture", exports: { ".": { import: "./esm.js", require: "./cjs.js" } } }),
    );
    writeFileSync(join(pkgDir, "esm.js"), "export const Agent = 'esm';\nexport const Cursor = 'esm';\n");
    // The trap this guards: a resolver taking the `require` condition would load this instead and find nothing.
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

/* A package directory with no declared ESM entry is not a usable copy, and answering "here it is" would turn a
 * missing pack into an import that throws at turn time. It falls through to the checkout's own copy, which is
 * why this asserts a real SDK rather than undefined. */
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

// The sentence a surface routes to the Environment card. "rebuild" is load-bearing in it, so it is asserted
// rather than left to survive a rewording.
test("the missing-runtime message points at a rebuild", () => {
    expect(CURSOR_SDK_MISSING).toContain("rebuild");
});
