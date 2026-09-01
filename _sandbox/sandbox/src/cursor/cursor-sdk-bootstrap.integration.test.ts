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

/* The install writes into the ENGINE STORE now, where every other agent runtime's versions live, so the
 * fixture is written where a real `npm install --prefix` would have put it. That move is the point of the
 * change this suite covers: a Cursor bootstrap is no longer a private path with its own prefix, it is one
 * engine install like any other, and what it leaves behind is visible, revertable and version-pinned on the
 * Environment card. */
const writeSdk = (root: string, version: string): void => {
    const pkgDir = join(root, "cursor", "versions", version, "node_modules", "@cursor", "sdk");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ exports: { ".": { import: "./esm.js" } } }));
    writeFileSync(join(pkgDir, "esm.js"), "export class Agent {}\nexport class Cursor {}\n");
};

// A store of its own per case, so an activation in one is invisible to the next. The suite-wide fence
// (src/testing/engine-fence.ts) already keeps all of this off the machine's real store.
const emptyStore = (name: string): string => {
    const root = mkdtempSync(join(tmpdir(), name));
    process.env["INTENTIC_ENGINES_DIR"] = root;
    // No pack prefix either: the point of these cases is the published image, which carries neither.
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
    const { activateVersion } = await import("../engines/engine-store.js");

    /* The install is faked, the ACTIVATION is real: what this asserts is that ensureCursorSdk asks for the
     * pack's pinned version and then loads what the store now points at, which is the whole contract between
     * this bootstrap and the engine machinery. */
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
    // Once landed, another tab reuses the module instead of launching a second package install.
    await ensureCursorSdk(install);
    expect(install).toHaveBeenCalledOnce();
});

test("a failed bootstrap can be retried", async () => {
    const store = emptyStore("cursor-bootstrap-retry-");
    const { activateVersion } = await import("../engines/engine-store.js");

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

// An install that reports failure is reported as one rather than being read as "the runtime is not here":
// the two states are a retry and a rebuild, and telling them apart is the whole reason the outcome is checked.
test("a refused install surfaces the store's reason", async () => {
    emptyStore("cursor-bootstrap-refused-");
    await expect(
        ensureCursorSdk(async (_id, version) => ({ ok: false as const, version, reason: "npm answered 403", quarantined: false })),
    ).rejects.toThrow("npm answered 403");
});
