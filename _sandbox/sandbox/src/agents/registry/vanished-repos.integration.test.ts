import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitInit } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { noIsolation } from "../../testing.js";
import { ensureRootRepo } from "../../git/remote/root-repo.js";
import { repoGitDir } from "../../history/history.js";
import { createLogger } from "../../logger.js";
import { createPerfTracker } from "../../platform/resources/perf.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { createAgentsRegistry, type AgentsRegistry } from "./agents-registry.js";
import type { AgentsStore, PersistedAgent } from "./agents-store.js";
import { dropVanishedRepos } from "./vanished-repos.js";
import { createAgentWorktrees, type AgentWorktrees } from "../worktrees/worktrees.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const memoryStore = (initial: PersistedAgent[] = []): AgentsStore & { saved: () => PersistedAgent[] } => {
    let data = initial;
    return {
        load: async () => data,
        save: async (agents) => {
            data = [...agents];
        },
        saved: () => data,
    };
};

const noStandings = { of: () => "idle" as const, refresh: async () => false, forget: () => {} };
const noPresences = { of: () => undefined, refresh: async () => false, forget: () => {}, metrics: () => ({}) };

// A production-shaped workspace: a root repo over /work, a nested repo, and two conversations spanning both, with real
// checkouts on the history volume.
const setup = async (): Promise<{
    work: string;
    historyRoot: string;
    worktrees: AgentWorktrees;
    agents: AgentsRegistry;
    store: ReturnType<typeof memoryStore>;
}> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-vanished-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    // Client repo created before the root repo, matching production boot order.
    const client = join(work, "client");
    await gitInit(client, repoGitDir(historyRoot, "client"));
    await writeFile(join(client, "index.ts"), "v1\n");
    await sh(client, "add", "-A");
    await commit(client, "client v1");
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "CLAUDE.md"), "workspace notes\n");
    await sh(work, "add", "-A");
    await commit(work, "baseline");
    const worktrees = createAgentWorktrees({
        workspace,
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: noIsolation(work, historyRoot),
        logger,
        perf,
    });
    const store = memoryStore();
    const agents = createAgentsRegistry(store, noStandings, noPresences);
    await agents.init();
    for (const id of ["c1", "c2"]) {
        await agents.begin({ conversationId: id, isolated: true, prompt: "work", provider: "claude", harness: "native" }, 1_000);
        const conversation = await worktrees.ensure(id, []);
        await agents.recordWorktree(id, conversation.repos);
    }
    // c2 is archived, since the sweep must cover archived rows too, not just live ones.
    await agents.setArchived(["c2"], 2_000);
    return { work, historyRoot, worktrees, agents, store };
};

const reposOf = (agents: AgentsRegistry, id: string): string[] => (agents.entry(id)?.repos ?? []).map(({ repo }) => repo);

test("a workspace with nothing deleted is left exactly as it is", async () => {
    const { worktrees, agents, historyRoot } = await setup();
    expect(reposOf(agents, "c1")).toEqual(["root", "client"]);

    expect(await dropVanishedRepos({ agents, agentWorktrees: worktrees, logger })).toEqual([]);

    expect(reposOf(agents, "c1")).toEqual(["root", "client"]);
    expect(reposOf(agents, "c2")).toEqual(["root", "client"]);
    expect(existsSync(join(worktrees.conversationDir("c1"), "client"))).toBe(true);
    expect(existsSync(join(historyRoot, "trash"))).toBe(false);
});

test("a repo deleted from the workspace leaves every composition, live and archived", async () => {
    const { work, worktrees, agents, store } = await setup();
    await rm(join(work, "client"), { recursive: true, force: true });

    expect(await dropVanishedRepos({ agents, agentWorktrees: worktrees, logger })).toEqual(["client"]);

    expect(reposOf(agents, "c1")).toEqual(["root"]);
    expect(reposOf(agents, "c2")).toEqual(["root"]);
    expect(store.saved().map((entry) => entry.repos.map(({ repo }) => repo))).toEqual([["root"], ["root"]]);
    // Idempotent: a repeat sweep costs nothing once the rows are gone.
    expect(await dropVanishedRepos({ agents, agentWorktrees: worktrees, logger })).toEqual([]);
});

// A leftover checkout becomes untracked content of the root worktree once its repo drops from the exclude list; left
// alone, the next `add -A` would sweep it onto the branch.
test("the deleted repo's checkouts are reclaimed out of every conversation, into the trash", async () => {
    const { work, historyRoot, worktrees, agents } = await setup();
    // scratch.ts is never committed, so the reclaim moving it (not deleting it) is the only way it survives.
    await writeFile(join(worktrees.conversationDir("c1"), "client", "scratch.ts"), "unfinished\n");
    await rm(join(work, "client"), { recursive: true, force: true });

    await dropVanishedRepos({ agents, agentWorktrees: worktrees, logger });

    for (const id of ["c1", "c2"]) {
        expect(existsSync(join(worktrees.conversationDir(id), "client"))).toBe(false);
        // Only the dead repo's directory is gone; the rest of the checkout stays.
        expect(existsSync(join(worktrees.conversationDir(id), "CLAUDE.md"))).toBe(true);
    }
    const trashed = await readdir(join(historyRoot, "trash"));
    expect(trashed).toHaveLength(2);
    expect(trashed.every((entry) => entry.startsWith("client-"))).toBe(true);
    expect(existsSync(join(historyRoot, "trash", trashed.find((entry) => entry.includes("c1")) ?? "", "scratch.ts"))).toBe(true);
});

// A momentary discovery failure must not read as deletion, since it would strip live repos from every conversation;
// only a directory that is actually gone counts.
test("a repo that stopped being a repo but kept its files is never dropped", async () => {
    const { work, worktrees, agents } = await setup();
    // No .git, but the files remain: the case a weaker "git will not answer" test would misread as a deletion.
    await rm(join(work, "client", ".git"), { recursive: true, force: true });

    expect(await dropVanishedRepos({ agents, agentWorktrees: worktrees, logger })).toEqual([]);

    expect(reposOf(agents, "c1")).toEqual(["root", "client"]);
    expect(existsSync(join(worktrees.conversationDir("c1"), "client"))).toBe(true);
    expect(existsSync(join(work, "client", "index.ts"))).toBe(true);
});
