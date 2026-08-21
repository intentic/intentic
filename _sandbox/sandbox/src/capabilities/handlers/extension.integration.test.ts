import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Capability, CapabilitySchema } from "@intentic/sandbox-contract";
import { gitHead } from "@intentic/scaffold";
import { expect, test } from "vitest";
import type { Services } from "../../composition.js";
import { unstubbed } from "@intentic/testing";
import { testConfig } from "../../testing.js";
import { extensionAgentDirsOf } from "../../extensions/installed-extensions.js";
import { extensionDir, extensionsRoot } from "../extension-dirs.js";
import { previousDir } from "../git-checkout.js";
import { createTerminalRunner } from "../../terminal/terminal-run.js";
import { makeWorkspaceDir, moveWorkspacePath, readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { echoConfig } from "../summary.js";
import { extensionHandler } from "./extension.js";

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]);

// A ctx exposing only what extensionHandler touches, over a fresh temp workspace (the plugin.integration.test.ts pattern).
// `stopped` records ctx.panels.stop calls for the remove/update quiesce tests; `stored` is the capability store
// the update path reads the OUTGOING config from (empty ⇒ a first install); `donatedTo` records the donation
// gate's calls (the premium install/update path).
const tempCtx = (member = false): { ctx: CapabilityCtx; root: string; stopped: string[]; stored: Map<string, Capability>; donatedTo: string[] } => {
    const root = mkdtempSync(join(tmpdir(), "extension-cap-"));
    const stopped: string[] = [];
    const stored = new Map<string, Capability>();
    const donatedTo: string[] = [];
    const ctx = {
        workspace: { root },
        files: { read: readWorkspaceFile, mkdir: makeWorkspaceDir, remove: removeWorkspacePath, move: moveWorkspacePath },
        git: { head: gitHead },
        terminalRun: createTerminalRunner(),
        panels: { stop: (key: string) => stopped.push(key) },
        capabilities: { get: async (id: string) => stored.get(id) },
        donatePremium: async (extensionId: string) => {
            if (!member) {
                return { ok: false, donated: 0, detail: "Installing a premium extension needs an intentic membership." };
            }
            donatedTo.push(extensionId);
            return { ok: true, donated: 200 };
        },
    } as unknown as CapabilityCtx;
    return { ctx, root, stopped, stored, donatedTo };
};

const MANIFEST = {
    publisher: "acme",
    name: "demo",
    version: "1.0.0",
    engines: { intentic: "^0.1" },
    entry: "dist/extension.js",
    contributes: { agent: {}, processes: [{ name: "worker", command: "node worker.js" }] },
};

// A local "remote" carrying an intentic extension; `commit` returns the FULL sha (the config schema pins on it).
const fixtureRepo = async (manifest: object | undefined, withEntry: boolean): Promise<{ url: string; sha: string }> => {
    const dir = mkdtempSync(join(tmpdir(), "extension-remote-"));
    await git(dir, "init", "-q");
    if (manifest !== undefined) {
        await writeWorkspaceFile(join(dir, "intentic-extension.json"), JSON.stringify(manifest));
    }
    if (withEntry) {
        await makeWorkspaceDir(join(dir, "dist"));
        await writeWorkspaceFile(join(dir, "dist", "extension.js"), "export default { activate() {} };");
    }
    await git(dir, "add", "-A");
    await git(dir, "-c", "user.name=t", "-c", "user.email=t@t.dev", "commit", "-q", "-m", "init");
    const { stdout } = await git(dir, "rev-parse", "HEAD");
    return { url: dir, sha: stdout.trim() };
};

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

test("apply installs a valid extension; status carries the pinned sha", async () => {
    const { ctx, root } = tempCtx();
    const remote = await fixtureRepo(MANIFEST, true);
    const config = { url: remote.url, ref: remote.sha };
    expect(await extensionHandler.status(ctx, "demo", config)).toEqual({ state: "inactive" });

    await drain(extensionHandler.apply(ctx, "demo", config));

    expect(await readWorkspaceFile(join(extensionDir(root, "demo"), "dist", "extension.js"))).toContain("activate");
    expect(await extensionHandler.status(ctx, "demo", config)).toEqual({ state: "active", detail: await gitHead(extensionDir(root, "demo")) });
});

test("a premium install whose donation is refused never goes live, and says why", async () => {
    const { ctx, root, donatedTo } = tempCtx(false);
    const remote = await fixtureRepo(MANIFEST, true);
    await expect(drain(extensionHandler.apply(ctx, "demo", { url: remote.url, ref: remote.sha, tier: "premium" }))).rejects.toThrow(
        /premium extension.*needs an intentic membership/,
    );
    expect(donatedTo).toEqual([]);
    expect(await readdir(extensionsRoot(root)).catch(() => [])).toEqual([]);
});

test("a premium install donates to the manifest-derived identity, then proceeds like any other", async () => {
    const { ctx, root, donatedTo } = tempCtx(true);
    const remote = await fixtureRepo(MANIFEST, true);
    await drain(extensionHandler.apply(ctx, "demo", { url: remote.url, ref: remote.sha, tier: "premium" }));
    // publisher.name from the checkout's own manifest: never the capability entry id the form chose.
    expect(donatedTo).toEqual(["acme.demo"]);
    expect(await readWorkspaceFile(join(extensionDir(root, "demo"), "dist", "extension.js"))).toContain("activate");
});

test("a free install never touches the donation path", async () => {
    const { ctx, donatedTo } = tempCtx(true);
    const remote = await fixtureRepo(MANIFEST, true);
    await drain(extensionHandler.apply(ctx, "demo", { url: remote.url, ref: remote.sha }));
    expect(donatedTo).toEqual([]);
});

test("a checkout without a manifest is rejected before it goes live, leaving no debris", async () => {
    const { ctx, root } = tempCtx();
    const remote = await fixtureRepo(undefined, true);
    await expect(drain(extensionHandler.apply(ctx, "demo", { url: remote.url, ref: remote.sha }))).rejects.toThrow(/no intentic-extension.json/);
    expect(await readdir(extensionsRoot(root))).toEqual([]);
});

test("a manifest naming a missing entry bundle is rejected: prebuilt dist is mandatory", async () => {
    const { ctx } = tempCtx();
    const remote = await fixtureRepo(MANIFEST, false);
    await expect(drain(extensionHandler.apply(ctx, "demo", { url: remote.url, ref: remote.sha }))).rejects.toThrow(/prebuilt bundle/);
});

test("remove stops the manifest's declared processes, then deletes the checkout", async () => {
    const { ctx, stopped } = tempCtx();
    const remote = await fixtureRepo(MANIFEST, true);
    const config = { url: remote.url, ref: remote.sha };
    await drain(extensionHandler.apply(ctx, "demo", config));
    await extensionHandler.remove!(ctx, "demo", config);
    expect(stopped).toEqual(["ext-demo-worker"]);
    expect(await extensionHandler.status(ctx, "demo", config)).toEqual({ state: "inactive" });
});

// A second commit on the fixture "remote": what an author publishing an update looks like to the handler.
const publishUpdate = async (url: string, manifest: object): Promise<string> => {
    await writeWorkspaceFile(join(url, "intentic-extension.json"), JSON.stringify(manifest));
    await git(url, "add", "-A");
    await git(url, "-c", "user.name=t", "-c", "user.email=t@t.dev", "commit", "-q", "-m", "update");
    return (await git(url, "rev-parse", "HEAD")).stdout.trim();
};

test("an update quiesces the outgoing checkout's processes and keeps it one version back", async () => {
    const { ctx, root, stopped, stored } = tempCtx();
    const remote = await fixtureRepo(MANIFEST, true);
    const v1 = { url: remote.url, ref: remote.sha };
    await drain(extensionHandler.apply(ctx, "demo", v1));
    stored.set("demo", { id: "demo", kind: "extension", config: v1 });
    // A first install quiesced nothing: there was nothing running to stop.
    expect(stopped).toEqual([]);

    const sha2 = await publishUpdate(remote.url, { ...MANIFEST, version: "1.1.0" });
    await drain(extensionHandler.apply(ctx, "demo", { url: remote.url, ref: sha2 }));

    // The OLD manifest's declared process was stopped at the swap: the post-apply seam restarts on new code.
    expect(stopped).toEqual(["ext-demo-worker"]);
    // The live checkout is the update; the outgoing version is kept one back, revert's whole subject.
    expect(JSON.parse((await readWorkspaceFile(join(extensionDir(root, "demo"), "intentic-extension.json")))!).version).toBe("1.1.0");
    expect(JSON.parse((await readWorkspaceFile(join(previousDir(extensionsRoot(root), "demo"), "intentic-extension.json")))!).version).toBe("1.0.0");
});

test("remove deletes the kept-previous checkout along with the live one", async () => {
    const { ctx, root, stored } = tempCtx();
    const remote = await fixtureRepo(MANIFEST, true);
    await drain(extensionHandler.apply(ctx, "demo", { url: remote.url, ref: remote.sha }));
    stored.set("demo", { id: "demo", kind: "extension", config: { url: remote.url, ref: remote.sha } });
    const sha2 = await publishUpdate(remote.url, { ...MANIFEST, version: "1.1.0" });
    await drain(extensionHandler.apply(ctx, "demo", { url: remote.url, ref: sha2 }));

    await extensionHandler.remove!(ctx, "demo", { url: remote.url, ref: sha2 });
    expect(await readdir(extensionsRoot(root))).toEqual([]);
});

test("a broken update never replaces the working install: the old version stays live, still running", async () => {
    const { ctx, root, stopped, stored } = tempCtx();
    const remote = await fixtureRepo(MANIFEST, true);
    await drain(extensionHandler.apply(ctx, "demo", { url: remote.url, ref: remote.sha }));
    stored.set("demo", { id: "demo", kind: "extension", config: { url: remote.url, ref: remote.sha } });

    // The author ships a release whose manifest names an entry that isn't committed.
    const broken = await publishUpdate(remote.url, { ...MANIFEST, version: "1.1.0", entry: "dist/missing.js" });
    await expect(drain(extensionHandler.apply(ctx, "demo", { url: remote.url, ref: broken }))).rejects.toThrow(/prebuilt bundle/);

    // Validation failed BEFORE the quiesce: nothing was stopped, and the working version is untouched.
    expect(stopped).toEqual([]);
    expect(JSON.parse((await readWorkspaceFile(join(extensionDir(root, "demo"), "intentic-extension.json")))!).version).toBe("1.0.0");
});

test("extensionAgentDirsOf maps contributes.agent checkouts (honoring config.path and agent.path)", async () => {
    const { ctx, root } = tempCtx();
    const remote = await fixtureRepo({ ...MANIFEST, contributes: { agent: { path: "plugin" } } }, true);
    await drain(extensionHandler.apply(ctx, "with-agent", { url: remote.url, ref: remote.sha }));
    const noAgent = await fixtureRepo({ ...MANIFEST, contributes: {} }, true);
    await drain(extensionHandler.apply(ctx, "no-agent", { url: noAgent.url, ref: noAgent.sha }));

    const capabilities: Capability[] = [
        { id: "with-agent", kind: "extension", config: { url: remote.url, ref: remote.sha } },
        { id: "no-agent", kind: "extension", config: { url: noAgent.url, ref: noAgent.sha } },
        { id: "x", kind: "mcp", config: { url: "https://a/mcp" } },
    ];
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", { read: ctx.files.read }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => capabilities }),
        config: { ...testConfig, extensionsDir: "" },
    });
    expect(await extensionAgentDirsOf(services)).toEqual([join(extensionDir(root, "with-agent"), "plugin")]);
});

test("the config schema requires a full 40-character sha ref", () => {
    const base = { id: "demo", kind: "extension" as const };
    const sha = "a".repeat(40);
    expect(CapabilitySchema.safeParse({ ...base, config: { url: "https://x/y.git", ref: sha } }).success).toBe(true);
    expect(CapabilitySchema.safeParse({ ...base, config: { url: "https://x/y.git", ref: "main" } }).success).toBe(false);
    expect(CapabilitySchema.safeParse({ ...base, config: { url: "https://x/y.git" } }).success).toBe(false);
});

test("echoConfig echoes url/ref/path and hasToken, never the token", () => {
    const sha = "b".repeat(40);
    const full: Capability = { id: "e", kind: "extension", config: { url: "https://x/y.git", ref: sha, path: "packages/e", token: "secret" } };
    expect(echoConfig(full, new Map())).toEqual({ url: "https://x/y.git", ref: sha, path: "packages/e", hasToken: true });
});
