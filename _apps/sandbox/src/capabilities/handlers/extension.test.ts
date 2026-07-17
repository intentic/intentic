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
import { extensionAgentDirsOf } from "../../extensions/installed-extensions.js";
import { extensionDir, extensionsRoot } from "../extension-dirs.js";
import { createTerminalRunner } from "../../terminal/terminal-run.js";
import { makeWorkspaceDir, moveWorkspacePath, readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { echoConfig } from "../capability.js";
import { extensionHandler } from "./extension.js";

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]);

// A ctx exposing only what extensionHandler touches, over a fresh temp workspace (the plugin.test.ts pattern).
// `stopped` records ctx.panels.stop calls for the remove test.
const tempCtx = (): { ctx: CapabilityCtx; root: string; stopped: string[] } => {
    const root = mkdtempSync(join(tmpdir(), "extension-cap-"));
    const stopped: string[] = [];
    const ctx = {
        workspace: { root },
        files: { read: readWorkspaceFile, mkdir: makeWorkspaceDir, remove: removeWorkspacePath, move: moveWorkspacePath },
        git: { head: gitHead },
        terminalRun: createTerminalRunner(),
        panels: { stop: (key: string) => stopped.push(key) },
    } as unknown as CapabilityCtx;
    return { ctx, root, stopped };
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

test("a checkout without a manifest is rejected before it goes live, leaving no debris", async () => {
    const { ctx, root } = tempCtx();
    const remote = await fixtureRepo(undefined, true);
    await expect(drain(extensionHandler.apply(ctx, "demo", { url: remote.url, ref: remote.sha }))).rejects.toThrow(/no intentic-extension.json/);
    expect(await readdir(extensionsRoot(root))).toEqual([]);
});

test("a manifest naming a missing entry bundle is rejected — prebuilt dist is mandatory", async () => {
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
    const services = {
        workspace: { root },
        files: { read: ctx.files.read },
        capabilities: { list: async () => capabilities },
        config: { extensionsDir: "" },
    } as unknown as Services;
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
    expect(echoConfig(full)).toEqual({ url: "https://x/y.git", ref: sha, path: "packages/e", hasToken: true });
});
