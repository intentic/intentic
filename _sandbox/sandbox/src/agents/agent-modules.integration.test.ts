import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { agentRepoModules } from "./land/agent-changes.js";
import type { IsolatedAgent } from "./registry/agents-store.js";
import type { AgentWorktrees } from "./worktrees/worktrees.js";

// A package an agent just created exists only in its worktree, not /work, so package names come from there. Real
// directories, not a mocked fs; git is stubbed via `attached`.

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

// Main tree and worktree disagree: the worktree has the package the agent started from plus one created this turn; the
// main tree has only the first.
const setup = async (): Promise<{ worktrees: AgentWorktrees; attached: boolean[] }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-agent-modules-"));
    tempDirs.push(base);
    const main = join(base, "work");
    const worktree = join(base, "worktrees", "a1");
    await manifest(join(main, "_libs/auth"), "@shop/auth");
    await manifest(join(worktree, "_libs/auth"), "@shop/auth");
    await manifest(join(worktree, "_libs/billing"), "@shop/billing");
    // Shared flag: the stub reads it, the test sets it to choose the state under test.
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

// Mirrors the attached/main fallback `agentRepoScope` uses.
test("falls back to the main tree once the checkout is gone", async () => {
    const { worktrees, attached } = await setup();
    attached[0] = false;
    expect(names(await agentRepoModules(worktrees, ENTRY, "root"))).toEqual(["@shop/auth"]);
});
