import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

// Models the deployed tree, where prepare-image-trees.sh prunes this dependency; the packed fixture below is a file-URL
// import and stays visible.
vi.mock("@cursor/sdk", () => {
    throw new Error("pruned from the published image");
});

const { ensureCursorSdk, forgetCursorSdk } = await import("./cursor-sdk.js");

// Writes into the engine store, same as every other runtime's versions, not a private prefix; what it leaves behind is
// visible, revertible and version-pinned.
const writeSdk = (root: string, version: string): void => {
    const pkgDir = join(root, "cursor", "versions", version, "node_modules", "@cursor", "sdk");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ exports: { ".": { import: "./esm.js" } } }));
    writeFileSync(join(pkgDir, "esm.js"), "export class Agent {}\nexport class Cursor {}\n");
};

// A store of its own per case, so one case's activation is invisible to the next; the suite-wide fence
// (engine-fence.ts) keeps all of it off the real store.
const emptyStore = (name: string): string => {
    const root = mkdtempSync(join(tmpdir(), name));
    process.env["INTENTIC_ENGINES_DIR"] = root;
    // No pack prefix either: these cases model the published image, which carries neither.
    process.env["INTENTIC_CURSOR_SDK_DIR"] = mkdtempSync(join(tmpdir(), `${name}-nopack-`));
    forgetCursorSdk();
    return root;
};

afterEach(() => {
    delete process.env["INTENTIC_CURSOR_SDK_DIR"];
    forgetCursorSdk();
});

test("an explicit connect installs the pack's pinned version into the engine store", async () => {
    const store = emptyStore("cursor-bootstrap-");
    const { activateVersion } = await import("../../engines/engine-store.js");

    // Install is faked, activation is real: proves this asks for the pinned version, loads the store's answer.
    const install = vi.fn(async (id: "cursor", version: string) => {
        expect(id).toBe("cursor");
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        writeSdk(store, version);
        await activateVersion("cursor", version);
        forgetCursorSdk();
        return { ok: true as const, version, reused: false };
    });

    const sdk = await ensureCursorSdk(install);

    expect(install).toHaveBeenCalledOnce();
    expect(sdk.Agent).toBeTypeOf("function");
    expect(sdk.Cursor).toBeTypeOf("function");
    await ensureCursorSdk(install);
    expect(install).toHaveBeenCalledOnce();
});

test("a failed bootstrap can be retried", async () => {
    const store = emptyStore("cursor-bootstrap-retry-");
    const { activateVersion } = await import("../../engines/engine-store.js");

    await expect(
        ensureCursorSdk(async () => {
            throw new Error("registry unavailable");
        }),
    ).rejects.toThrow("registry unavailable");

    const install = vi.fn(async (_id: "cursor", version: string) => {
        writeSdk(store, version);
        await activateVersion("cursor", version);
        forgetCursorSdk();
        return { ok: true as const, version, reused: false };
    });
    expect((await ensureCursorSdk(install)).Cursor).toBeTypeOf("function");
    expect(install).toHaveBeenCalledOnce();
});

test("a refused install surfaces the store's reason", async () => {
    emptyStore("cursor-bootstrap-refused-");
    await expect(
        ensureCursorSdk(async (_id, version) => ({ ok: false as const, version, reason: "npm answered 403", quarantined: false })),
    ).rejects.toThrow("npm answered 403");
});
