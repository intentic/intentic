import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

// Model the deployed tree, where prepare-image-trees.sh has pruned this dependency. The packed fixture the
// explicit install writes below is a file-URL import and therefore remains visible.
vi.mock("@cursor/sdk", () => {
    throw new Error("pruned from the published image");
});

const { ensureCursorSdk, forgetCursorSdk } = await import("./cursor-sdk.js");

const writeSdk = (root: string): void => {
    const pkgDir = join(root, "node_modules", "@cursor", "sdk");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ exports: { ".": { import: "./esm.js" } } }));
    writeFileSync(join(pkgDir, "esm.js"), "export class Agent {}\nexport class Cursor {}\n");
};

afterEach(() => {
    delete process.env["INTENTIC_CURSOR_SDK_DIR"];
    forgetCursorSdk();
});

test("an explicit connect bootstraps the pack's pinned SDK into a published image", async () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-bootstrap-"));
    process.env["INTENTIC_CURSOR_SDK_DIR"] = root;
    forgetCursorSdk();

    const install = vi.fn(async (prefix: string, spec: string) => {
        expect(prefix).toBe(root);
        expect(spec).toMatch(/^@cursor\/sdk@\d/);
        writeSdk(prefix);
    });

    const sdk = await ensureCursorSdk(install);

    expect(install).toHaveBeenCalledOnce();
    expect(sdk.Agent).toBeTypeOf("function");
    expect(sdk.Cursor).toBeTypeOf("function");
    // Once landed, another tab reuses the module instead of launching a second package install.
    await ensureCursorSdk(install);
    expect(install).toHaveBeenCalledOnce();
});

test("a failed bootstrap can be retried", async () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-bootstrap-retry-"));
    process.env["INTENTIC_CURSOR_SDK_DIR"] = root;
    forgetCursorSdk();

    await expect(
        ensureCursorSdk(async () => {
            throw new Error("registry unavailable");
        }),
    ).rejects.toThrow("registry unavailable");

    const install = vi.fn(async (prefix: string) => writeSdk(prefix));
    expect((await ensureCursorSdk(install)).Cursor).toBeTypeOf("function");
    expect(install).toHaveBeenCalledOnce();
});
