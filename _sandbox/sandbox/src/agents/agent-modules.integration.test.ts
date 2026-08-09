import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { agentRepoModules } from "./agent-changes.js";
import type { IsolatedAgent } from "./agents-store.js";
import type { AgentWorktrees } from "./worktrees.js";

/* WHICH TREE NAMES AN AGENT'S PACKAGES — the whole subject here, because getting it wrong is invisible until
 * the moment it matters most. The review groups an agent's changed files under the package each one lives in;
 * an agent writes in a worktree; and a package it has just CREATED exists only there. Answering from /work then
 * leaves every file of that package — which is all of its files — in the unnamed "loose in this repo" bucket.
 *
 * Real directories rather than a mocked fs: the thing under test is a filesystem walk, so a fake fs would only
 * be testing the fake. No git, though — the seam is `attached`, and these tests own both sides of it. */

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const manifest = async (dir: string, name: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name }));
};

/* A workspace and a worktree that DISAGREE: the main tree has the package the agent started from, the worktree
 * has that one plus the one this turn created. Only the worktree's reading contains both. */
const setup = async (): Promise<{ worktrees: AgentWorktrees; attached: boolean[] }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-agent-modules-"));
    tempDirs.push(base);
    const main = join(base, "work");
    const worktree = join(base, "worktrees", "a1");
    await manifest(join(main, "_libs/auth"), "@shop/auth");
    await manifest(join(worktree, "_libs/auth"), "@shop/auth");
    await manifest(join(worktree, "_libs/billing"), "@shop/billing");
    // One flag both the stub and the assertions read, so a test says which state it is in by setting it.
    const attached = [true];
    return {
        attached,
        worktrees: {
            mainDir: () => main,
            worktreeDir: () => worktree,
            attached: () => Promise.resolve(attached[0]!),
        } as unknown as AgentWorktrees,
    };
};

const ENTRY = { id: "a1" } as IsolatedAgent;
const names = (modules: readonly { name: string }[]): string[] => modules.map((module) => module.name).toSorted();

test("names the packages of the agent's own checkout, including one the main tree has never seen", async () => {
    const { worktrees } = await setup();
    expect(names(await agentRepoModules(worktrees, ENTRY, "root"))).toEqual(["@shop/auth", "@shop/billing"]);
});

/* A RETIRED checkout has no worktree left to read, so the main repo answers — the same per-repo seam the file
 * diff beside it uses. By then the agent's work has normally landed, which is what makes that the right
 * fallback rather than merely the only cheap one. */
test("falls back to the main tree once the checkout is gone", async () => {
    const { worktrees, attached } = await setup();
    attached[0] = false;
    expect(names(await agentRepoModules(worktrees, ENTRY, "root"))).toEqual(["@shop/auth"]);
});
