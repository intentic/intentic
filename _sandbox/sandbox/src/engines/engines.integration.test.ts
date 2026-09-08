import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { forgetBlessedList } from "./engine-channel.js";
import { engineDescriptor } from "./engine-descriptors.js";
import { forgetEngineResolution } from "./engine-resolve.js";
import { activateVersion, engineVersionDir, forgetEngineStates, readEngineState } from "./engine-store.js";
import { type EngineHost, type EngineInstaller, enginesView, revertEngine, setChannel, updateEngine } from "./engines.js";

// Pins when the lifecycle installs something and when it deliberately does not, with the download itself faked.

const host = (root: string): EngineHost => ({
    workspace: { root },
    logger: { info: () => undefined, warn: () => undefined } as unknown as EngineHost["logger"],
});

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

// A store copy of opencode; its descriptor asks only for a binary, keeping this about the lifecycle, not npm.
const writeStoreCopy = (version: string): void => {
    const binDir = join(engineVersionDir("opencode", version), "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "opencode"), "#!/bin/sh\necho fixture\n", { mode: 0o755 });
};

const installer = (): EngineInstaller & { calls: string[] } => {
    const calls: string[] = [];
    const install = vi.fn(async (_id: "claude" | "codex" | "cursor" | "opencode" | "translator", version: string) => {
        calls.push(version);
        writeStoreCopy(version);
        await activateVersion("opencode", version);
        forgetEngineResolution("opencode");
        return { ok: true as const, version, reused: false };
    });
    return Object.assign(install as unknown as EngineInstaller, { calls });
};

let workspace: string;

beforeEach(() => {
    process.env["INTENTIC_ENGINES_DIR"] = mkdtempSync(join(tmpdir(), "engines-lifecycle-"));
    workspace = mkdtempSync(join(tmpdir(), "engines-workspace-"));
    forgetEngineStates();
    forgetEngineResolution();
    forgetBlessedList();
    process.env["INTENTIC_ENGINES_LIST_URL"] = "https://example.test/engines.json";
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["INTENTIC_ENGINES_LIST_URL"];
    forgetBlessedList();
});

// On a fresh sandbox the blessed version already is what the image bakes; comparing against the store instead would
// reinstall it on every box.
test("a blessed version the image already bakes installs nothing", async () => {
    const baked = await engineDescriptor("opencode").baked();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engines: { opencode: { blessed: baked } } })));

    const install = installer();
    expect(await updateEngine(host(workspace), "opencode", undefined, install)).toBeUndefined();
    expect(install.calls).toEqual([]);
});

test("a blessed version the image does not have is taken", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engines: { opencode: { blessed: "9.9.9" } } })));

    const install = installer();
    expect(await updateEngine(host(workspace), "opencode", undefined, install)).toEqual({
        ok: true,
        version: "9.9.9",
        source: "store",
        fromNextTurn: true,
    });
    expect(install.calls).toEqual(["9.9.9"]);
    expect((await readEngineState("opencode")).active).toBe("9.9.9");
});

// Must report the same fact the resolver serves to a turn, not just what's convenient for the row.
test("the view reports what is running and where it came from", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engines: { opencode: { blessed: "9.9.9" } } })));
    const install = installer();
    await updateEngine(host(workspace), "opencode", undefined, install);
    forgetEngineResolution();

    const view = await enginesView(host(workspace));
    const row = view.engines.find((engine) => engine.id === "opencode");
    expect(row?.running).toEqual({ version: "9.9.9", source: "store" });
    expect(row?.blessed).toBe("9.9.9");
    expect(row?.offered).toBeUndefined();
    expect(view.listSource).toBe("https://example.test/engines.json");
});

// Immediate because the image's copy is already on the machine; no check has to run first.
test("switching an engine to the image drops the store's version at once", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engines: { opencode: { blessed: "9.9.9" } } })));
    await updateEngine(host(workspace), "opencode", undefined, installer());

    await setChannel(host(workspace), "opencode", { kind: "image" });

    expect((await readEngineState("opencode")).active).toBeUndefined();
    forgetEngineResolution();
    const row = (await enginesView(host(workspace))).engines.find((engine) => engine.id === "opencode");
    expect(row?.running.source).toBe("image");
});

test("a revert returns to the version kept behind the current one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engines: { opencode: { blessed: "9.9.8" } } })));
    const install = installer();
    await updateEngine(host(workspace), "opencode", { version: "9.9.8" }, install);
    await updateEngine(host(workspace), "opencode", { version: "9.9.9" }, install);

    expect(await revertEngine(host(workspace), "opencode")).toEqual({ ok: true, version: "9.9.8", source: "store", fromNextTurn: true });
    expect((await readEngineState("opencode")).active).toBe("9.9.8");
});

// The update-anyway path: the caller holds a floor, not a version, since a turn just died on it.
test("a floor is resolved to the lowest published version that clears it", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
            url.includes("registry.npmjs.org")
                ? jsonResponse({ versions: { "1.0.0": {}, "1.2.0": {}, "1.5.0": {} } })
                : jsonResponse({ engines: { opencode: { blessed: "1.0.0" } } }),
        ),
    );

    const install = installer();
    await updateEngine(host(workspace), "opencode", { floor: "1.2.0" }, install);
    expect(install.calls).toEqual(["1.2.0"]);
});

test("a floor nothing published satisfies is refused rather than approximated", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ versions: { "1.0.0": {} } })));
    const install = installer();
    await expect(updateEngine(host(workspace), "opencode", { floor: "2.0.0" }, install)).rejects.toThrow("at or above 2.0.0");
    expect(install.calls).toEqual([]);
});

test("the view reports when an install is in flight", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engines: { opencode: { blessed: "9.9.9" } } })));
    let finishInstall: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
        finishInstall = resolve;
    });
    const install: EngineInstaller = vi.fn(async (_id, version) => {
        await pending;
        writeStoreCopy(version);
        await activateVersion("opencode", version);
        return { ok: true as const, version, reused: false };
    });

    const updatePromise = updateEngine(host(workspace), "opencode", undefined, install);

    const viewWhileInstalling = await enginesView(host(workspace));
    const rowWhileInstalling = viewWhileInstalling.engines.find((engine) => engine.id === "opencode");
    expect(rowWhileInstalling?.installing).toBe(true);

    finishInstall();
    await updatePromise;

    const viewAfter = await enginesView(host(workspace));
    const rowAfter = viewAfter.engines.find((engine) => engine.id === "opencode");
    expect(rowAfter?.installing).toBeUndefined();
});
