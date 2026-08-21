import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Capability } from "@intentic/sandbox-contract";
import { gitHead } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { createTerminalRunner } from "../../terminal/terminal-run.js";
import { makeWorkspaceDir, moveWorkspacePath, readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { echoConfig } from "../summary.js";
import { pluginDir, pluginDirsOf, pluginsRoot } from "../plugin-dirs.js";
import { pluginHandler } from "./plugin.js";

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]);

// A ctx exposing only what pluginHandler touches (files + git.head + the terminal runner + workspace.root),
// over a fresh temp workspace. The runner is the real one in its no-tmux fallback: the handler's clone/
// checkout commands run as plain bash against a local fixture repo, offline.
const tempCtx = (): { ctx: CapabilityCtx; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "plugin-cap-"));
    const ctx = {
        workspace: { root },
        files: { read: readWorkspaceFile, mkdir: makeWorkspaceDir, remove: removeWorkspacePath, move: moveWorkspacePath },
        git: { head: gitHead },
        terminalRun: createTerminalRunner(),
    } as unknown as CapabilityCtx;
    return { ctx, root };
};

// A local "remote": a plain git repo the handler clones by path. `commit` adds a file and returns the short sha.
const fixtureRepo = async (): Promise<{ url: string; commit: (name: string) => Promise<string> }> => {
    const dir = mkdtempSync(join(tmpdir(), "plugin-remote-"));
    await git(dir, "init", "-q");
    const commit = async (name: string): Promise<string> => {
        await writeWorkspaceFile(join(dir, name), name);
        await git(dir, "add", "-A");
        await git(dir, "-c", "user.name=t", "-c", "user.email=t@t.dev", "commit", "-q", "-m", name);
        return gitHead(dir);
    };
    return { url: dir, commit };
};

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

test("apply clones the repo; status flips inactive -> active with the checkout's sha", async () => {
    const { ctx, root } = tempCtx();
    const remote = await fixtureRepo();
    const sha = await remote.commit("SKILL.md");
    expect(await pluginHandler.status(ctx, "demo", { url: remote.url })).toEqual({ state: "inactive" });

    await drain(pluginHandler.apply(ctx, "demo", { url: remote.url }));

    expect(await readWorkspaceFile(join(pluginDir(root, "demo"), "SKILL.md"))).toBe("SKILL.md");
    expect(await pluginHandler.status(ctx, "demo", { url: remote.url })).toEqual({ state: "active", detail: sha });
});

test("a pinned ref checks out that commit; re-add without the pin updates to the latest", async () => {
    const { ctx, root } = tempCtx();
    const remote = await fixtureRepo();
    const first = await remote.commit("one");
    const second = await remote.commit("two");

    await drain(pluginHandler.apply(ctx, "demo", { url: remote.url, ref: first }));
    expect(await pluginHandler.status(ctx, "demo", { url: remote.url, ref: first })).toEqual({ state: "active", detail: first });
    expect(await readWorkspaceFile(join(pluginDir(root, "demo"), "two"))).toBeUndefined();

    await drain(pluginHandler.apply(ctx, "demo", { url: remote.url }));
    expect(await pluginHandler.status(ctx, "demo", { url: remote.url })).toEqual({ state: "active", detail: second });
});

test("a failed clone throws, leaves no debris, and keeps a prior checkout active", async () => {
    const { ctx, root } = tempCtx();
    const missing = join(tmpdir(), "plugin-remote-does-not-exist");
    await expect(drain(pluginHandler.apply(ctx, "demo", { url: missing }))).rejects.toThrow();
    expect(await readdir(pluginsRoot(root))).toEqual([]);

    // An update whose clone fails must not tear down the working version.
    const remote = await fixtureRepo();
    const sha = await remote.commit("one");
    await drain(pluginHandler.apply(ctx, "demo", { url: remote.url }));
    await expect(drain(pluginHandler.apply(ctx, "demo", { url: missing }))).rejects.toThrow();
    expect(await pluginHandler.status(ctx, "demo", { url: remote.url })).toEqual({ state: "active", detail: sha });
});

test("remove deletes the checkout; status returns to inactive", async () => {
    const { ctx } = tempCtx();
    const remote = await fixtureRepo();
    await remote.commit("one");
    await drain(pluginHandler.apply(ctx, "demo", { url: remote.url }));
    await pluginHandler.remove!(ctx, "demo", { url: remote.url });
    expect(await pluginHandler.status(ctx, "demo", { url: remote.url })).toEqual({ state: "inactive" });
});

test("pluginDirsOf maps plugin capabilities to checkout dirs (honoring the subdir) and ignores other kinds", () => {
    const plain: Capability = { id: "a", kind: "plugin", config: { url: "https://x/y.git" } };
    const sub: Capability = { id: "b", kind: "plugin", config: { url: "https://x/m.git", path: "plugins/beta" } };
    const mcp: Capability = { id: "x", kind: "mcp", config: { url: "https://a/mcp" } };
    expect(pluginDirsOf([plain, sub, mcp], "/work")).toEqual(["/work/.intentic/records/plugins/a", "/work/.intentic/records/plugins/b/plugins/beta"]);
    expect(pluginDirsOf([mcp], "/work")).toEqual([]);
});

test("echoConfig echoes url/ref/path and hasToken, never the token", () => {
    const full: Capability = { id: "p", kind: "plugin", config: { url: "https://x/y.git", ref: "v1", path: "plugins/p", token: "secret" } };
    expect(echoConfig(full, new Map())).toEqual({ url: "https://x/y.git", ref: "v1", path: "plugins/p", hasToken: true });
    const bare: Capability = { id: "q", kind: "plugin", config: { url: "https://x/y.git" } };
    expect(echoConfig(bare, new Map())).toEqual({ url: "https://x/y.git", hasToken: false });
});
