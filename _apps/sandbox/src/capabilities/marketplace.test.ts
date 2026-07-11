import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitClone } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { makeWorkspaceDir, readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../workspace/workspace-files.js";
import type { CapabilityCtx } from "./capability.js";
import { browseMarketplace } from "./marketplace.js";
import { pluginsRoot } from "./plugin-dirs.js";

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]);

// A ctx exposing only what browseMarketplace touches, over a fresh temp workspace (real files + git, offline).
const tempCtx = (): { ctx: CapabilityCtx; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "marketplace-"));
    const ctx = {
        workspace: { root },
        files: { read: readWorkspaceFile, mkdir: makeWorkspaceDir, remove: removeWorkspacePath },
        git: { clone: gitClone },
    } as unknown as CapabilityCtx;
    return { ctx, root };
};

// A local marketplace "remote": a git repo whose only content is .claude-plugin/marketplace.json.
const fixtureMarketplace = async (content: string | undefined): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "marketplace-remote-"));
    await git(dir, "init", "-q");
    await writeWorkspaceFile(join(dir, content !== undefined ? ".claude-plugin/marketplace.json" : "README.md"), content ?? "not a marketplace");
    await git(dir, "add", "-A");
    await git(dir, "-c", "user.name=t", "-c", "user.email=t@t.dev", "commit", "-q", "-m", "init");
    return dir;
};

test("resolves every clonable source shape onto plugin-capability configs; npm stays uninstallable", async () => {
    const { ctx, root } = tempCtx();
    const url = await fixtureMarketplace(
        JSON.stringify({
            name: "acme",
            owner: { name: "Acme" },
            metadata: { pluginRoot: "./plugins" },
            plugins: [
                { name: "alpha", description: "Alpha tools", version: "1.0.0", source: "./alpha" },
                { name: "gh", source: { source: "github", repo: "owner/gh-plugin", ref: "v2" } },
                { name: "pinned", source: { source: "url", url: "https://example.com/p.git", ref: "main", sha: "abc123" } },
                { name: "sub", source: { source: "git-subdir", url: "https://example.com/mono.git", path: "tools/plugin", ref: "v1" } },
                { name: "npm-only", source: { source: "npm", package: "@acme/plugin" } },
            ],
        }),
    );

    const marketplace = await browseMarketplace(ctx, url);

    expect(marketplace).toEqual({
        name: "acme",
        plugins: [
            { name: "alpha", description: "Alpha tools", version: "1.0.0", install: { url, path: "plugins/alpha" } },
            { name: "gh", install: { url: "https://github.com/owner/gh-plugin.git", ref: "v2" } },
            // An exact sha pins harder than a ref when both are present.
            { name: "pinned", install: { url: "https://example.com/p.git", ref: "abc123" } },
            { name: "sub", install: { url: "https://example.com/mono.git", path: "tools/plugin", ref: "v1" } },
            { name: "npm-only" },
        ],
    });
    // The throwaway checkout is gone after the browse.
    expect(await readdir(pluginsRoot(root))).toEqual([]);
});

test("a repo without .claude-plugin/marketplace.json throws and still cleans up its checkout", async () => {
    const { ctx, root } = tempCtx();
    const url = await fixtureMarketplace(undefined);
    await expect(browseMarketplace(ctx, url)).rejects.toThrow(/not a plugin marketplace/);
    expect(await readdir(pluginsRoot(root))).toEqual([]);
});
