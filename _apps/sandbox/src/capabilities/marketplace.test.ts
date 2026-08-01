import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { REGISTRY_FACTS_FILE, REGISTRY_FILE } from "@intentic/registry";
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

// A local registry "remote": a git repo holding the curated file and, optionally, the scanner's facts file.
const fixtureMarketplace = async (content: string | undefined, facts?: string): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "marketplace-remote-"));
    await git(dir, "init", "-q");
    await writeWorkspaceFile(join(dir, content !== undefined ? REGISTRY_FILE : "README.md"), content ?? "not a marketplace");
    if (facts !== undefined) {
        await writeWorkspaceFile(join(dir, REGISTRY_FACTS_FILE), facts);
    }
    await git(dir, "add", "-A");
    await git(dir, "-c", "user.name=t", "-c", "user.email=t@t.dev", "commit", "-q", "-m", "init");
    return dir;
};

test("resolves every clonable source shape onto capability configs; npm stays uninstallable", async () => {
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

    // Every row carries a kind and a trust, defaulted here because this registry states neither. With no
    // stars and no push dates to rank on, the order falls through to the name.
    expect(marketplace).toEqual({
        name: "acme",
        plugins: [
            { name: "alpha", kind: "plugin", trust: "listed", description: "Alpha tools", version: "1.0.0", install: { url, path: "plugins/alpha" } },
            { name: "gh", kind: "plugin", trust: "listed", install: { url: "https://github.com/owner/gh-plugin.git", ref: "v2" } },
            { name: "npm-only", kind: "plugin", trust: "listed" },
            // An exact sha pins harder than a ref when both are present.
            { name: "pinned", kind: "plugin", trust: "listed", install: { url: "https://example.com/p.git", ref: "abc123" } },
            { name: "sub", kind: "plugin", trust: "listed", install: { url: "https://example.com/mono.git", path: "tools/plugin", ref: "v1" } },
        ],
    });
    // The throwaway checkout is gone after the browse.
    expect(await readdir(pluginsRoot(root))).toEqual([]);
});

test("joins the scanner's facts file onto the curated entries and sorts verified first", async () => {
    const { ctx } = tempCtx();
    const url = await fixtureMarketplace(
        JSON.stringify({
            name: "intentic",
            plugins: [
                { name: "popular", kind: "extension", source: { source: "github", repo: "acme/popular", sha: "a".repeat(40) } },
                { name: "checked", kind: "extension", trust: "verified", source: { source: "github", repo: "acme/checked", sha: "b".repeat(40) } },
                { name: "evil", kind: "extension", trust: "blocked", trustReason: "exfiltrates secrets", source: { source: "github", repo: "bad/evil" } },
            ],
        }),
        JSON.stringify({
            scannedAt: "2026-08-01T00:00:00.000Z",
            entries: [
                { name: "popular", stars: 900, pushedAt: "2026-07-30T00:00:00Z" },
                { name: "checked", stars: 2, pushedAt: "2026-07-31T00:00:00Z" },
            ],
        }),
    );

    const marketplace = await browseMarketplace(ctx, url);

    expect(marketplace.plugins.map((entry) => entry.name)).toEqual(["checked", "popular", "evil"]);
    expect(marketplace.plugins[0]).toMatchObject({ trust: "verified", stars: 2 });
    // A blocked row survives the browse — it is what the UI needs in order to say no with a reason.
    expect(marketplace.plugins[2]).toMatchObject({ trust: "blocked", trustReason: "exfiltrates secrets" });
});

test("a registry with no generated facts file resolves fine — most registries run no scanner", async () => {
    const { ctx } = tempCtx();
    const url = await fixtureMarketplace(JSON.stringify({ name: "team", plugins: [{ name: "internal", kind: "extension", source: "./internal" }] }));
    const marketplace = await browseMarketplace(ctx, url);
    expect(marketplace.plugins).toEqual([{ name: "internal", kind: "extension", trust: "listed", install: { url, path: "internal" } }]);
});

test("a repo without .claude-plugin/marketplace.json throws and still cleans up its checkout", async () => {
    const { ctx, root } = tempCtx();
    const url = await fixtureMarketplace(undefined);
    await expect(browseMarketplace(ctx, url)).rejects.toThrow(/not a plugin marketplace/);
    expect(await readdir(pluginsRoot(root))).toEqual([]);
});
