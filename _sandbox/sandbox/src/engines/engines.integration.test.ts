import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { forgetBlessedList } from "./engine-channel.js";
import { engineDescriptor } from "./engine-descriptors.js";
import { forgetEngineResolution } from "./engine-resolve.js";
import { activateVersion, engineVersionDir, forgetEngineStates, readEngineState } from "./engine-store.js";
import { type EngineHost, type EngineInstaller, enginesView, revertEngine, setChannel, updateEngine } from "./engines.js";

/* THE LIFECYCLE'S DECISIONS, with the download itself faked: what is being pinned here is when a sandbox
 * installs something and when it deliberately does not, which is the difference between a mechanism that keeps
 * a fleet current and one that re-downloads 300 MB per box for no reason. */

const host = (root: string): EngineHost => ({
    workspace: { root },
    logger: { info: () => undefined, warn: () => undefined } as unknown as EngineHost["logger"],
});

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

// A store copy of opencode: a binary is all its descriptor asks for, which keeps this about the lifecycle
// rather than about npm.
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

/* THE CASE THAT PAYS FOR THIS FILE. On a fresh sandbox the blessed version IS the version the image bakes, and
 * a check that compared the list against the STORE (empty there) would download a copy of what is already
 * installed — on every box, for every engine, forever. */
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

// The row is what an owner reads before pressing anything, so what it says about a store copy has to be the
// same fact the resolver serves to a turn.
test("the view reports what is running and where it came from", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engines: { opencode: { blessed: "9.9.9" } } })));
    const install = installer();
    await updateEngine(host(workspace), "opencode", undefined, install);
    forgetEngineResolution();

    const view = await enginesView(host(workspace));
    const row = view.engines.find((engine) => engine.id === "opencode");
    expect(row?.running).toEqual({ version: "9.9.9", source: "store" });
    expect(row?.blessed).toBe("9.9.9");
    // Nothing further on offer: the channel's answer is what is running.
    expect(row?.offered).toBeUndefined();
    expect(view.listSource).toBe("https://example.test/engines.json");
});

/* Switching to the image is the one channel change that acts immediately, because the copy it names is already
 * on the machine: an owner who says "run what the image has" does not then wait for a check. */
test("switching an engine to the image drops the store's version at once", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engines: { opencode: { blessed: "9.9.9" } } })));
    await updateEngine(host(workspace), "opencode", undefined, installer());

    await setChannel(host(workspace), "opencode", { kind: "image" });

    expect((await readEngineState("opencode")).active).toBeUndefined();
    forgetEngineResolution();
    const row = (await enginesView(host(workspace))).engines.find((engine) => engine.id === "opencode");
    expect(row?.running.source).toBe("image");
});

// Going back is a pointer move onto a copy that is still on disk, which is what makes it the safe thing to
// reach for when the newest version is the problem.
test("a revert returns to the version kept behind the current one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engines: { opencode: { blessed: "9.9.8" } } })));
    const install = installer();
    await updateEngine(host(workspace), "opencode", { version: "9.9.8" }, install);
    await updateEngine(host(workspace), "opencode", { version: "9.9.9" }, install);

    expect(await revertEngine(host(workspace), "opencode")).toEqual({ ok: true, version: "9.9.8", source: "store", fromNextTurn: true });
    expect((await readEngineState("opencode")).active).toBe("9.9.8");
});

/* The update-anyway path: a turn died on an upstream floor, and what the caller holds is the floor rather than
 * a version. The lowest published version at or above it is what gets installed — the smallest step that
 * works, not whatever happens to be newest. */
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
