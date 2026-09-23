import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Models the deployed tree, where prepare-image-trees.sh prunes this dependency; the packed fixture below is a file-URL
// import and stays visible. Re-declared per case: a factory that throws is honoured once per registration.
const prunedFromTheImage = (): void => {
    jest.mock("@cursor/sdk", () => {
        throw new Error("pruned from the published image");
    });
};
prunedFromTheImage();

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
    prunedFromTheImage();
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
    const install = jest.fn(async (id: "cursor", version: string) => {
        expect(id).toBe("cursor");
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        writeSdk(store, version);
        await activateVersion("cursor", version);
        forgetCursorSdk();
        return { ok: true as const, version, reused: false };
    });

    const sdk = await ensureCursorSdk(install);

    expect(install).toHaveBeenCalledTimes(1);
    expect(sdk.Agent).toBeTypeOf("function");
    expect(sdk.Cursor).toBeTypeOf("function");
    await ensureCursorSdk(install);
    expect(install).toHaveBeenCalledTimes(1);
});

test("a failed bootstrap can be retried", async () => {
    const store = emptyStore("cursor-bootstrap-retry-");
    const { activateVersion } = await import("../../engines/engine-store.js");

    await expect(
        ensureCursorSdk(async () => {
            throw new Error("registry unavailable");
        }),
    ).rejects.toThrow("registry unavailable");

    const install = jest.fn(async (_id: "cursor", version: string) => {
        writeSdk(store, version);
        await activateVersion("cursor", version);
        forgetCursorSdk();
        return { ok: true as const, version, reused: false };
    });
    expect((await ensureCursorSdk(install)).Cursor).toBeTypeOf("function");
    expect(install).toHaveBeenCalledTimes(1);
});

test("a refused install surfaces the store's reason", async () => {
    emptyStore("cursor-bootstrap-refused-");
    await expect(
        ensureCursorSdk(async (_id, version) => ({ ok: false as const, version, reason: "npm answered 403", quarantined: false })),
    ).rejects.toThrow("npm answered 403");
});
