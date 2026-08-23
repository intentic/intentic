import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitInit } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { noIsolation } from "../testing.js";
import { ensureRootRepo } from "../git/root-repo.js";
import { repoGitDir } from "../history/history.js";
import { createLogger } from "../logger.js";
import { createPerfTracker } from "../platform/perf.js";
import { workspacePaths } from "../workspace/workspace.js";
import { createAgentsRegistry, type AgentsRegistry } from "./agents-registry.js";
import type { AgentsStore, PersistedAgent } from "./agents-store.js";
import { dropVanishedRepos } from "./vanished-repos.js";
import { createAgentWorktrees, type AgentWorktrees } from "./worktrees.js";

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

/* A production-shaped workspace: a --separate-git-dir root repo over /work, one nested repo beside it, and two
 * conversations whose compositions span BOTH, with real checkouts on the history volume. That is the state a
 * deletion has to be reconciled against, and the reason this is an integration test: the whole question is
 * what is on the disk. */
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
    // Nested repo first, so the root repo's derived exclude list covers it (production boot order).
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
    // The second conversation is filed away: its rows are exactly the ones nobody looks at until a restore or
    // a purge reads them, which is why the sweep has to cover the archive too.
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

/* THE FIX FOR THE CAUSE. The user deletes a repo out of /work; the compositions that named it are frozen and
 * cannot drop it themselves, so every per-repo pass keeps running git in a directory that is not there. One
 * sweep takes the row out of every conversation, live and archived alike, and leaves the rest untouched. */
test("a repo deleted from the workspace leaves every composition, live and archived", async () => {
    const { work, worktrees, agents, store } = await setup();
    await rm(join(work, "client"), { recursive: true, force: true });

    expect(await dropVanishedRepos({ agents, agentWorktrees: worktrees, logger })).toEqual(["client"]);

    expect(reposOf(agents, "c1")).toEqual(["root"]);
    expect(reposOf(agents, "c2")).toEqual(["root"]);
    // Persisted, not just in memory: the next boot must not rediscover the row it just dropped.
    expect(store.saved().map((entry) => entry.repos.map(({ repo }) => repo))).toEqual([["root"], ["root"]]);
    // Idempotent, and the steady state costs nothing once the rows are gone.
    expect(await dropVanishedRepos({ agents, agentWorktrees: worktrees, logger })).toEqual([]);
});

/* THE STRANDED CHECKOUT, and why it cannot simply be left behind. The root repo's exclude list is derived from
 * the LIVE repo set and shared by every agent worktree (history.ts syncRootExcludes), so the moment `client`
 * stops being discovered, its leftover checkout INSIDE root's worktree is untracked content of the root
 * branch: the next `add -A` (a retire, a land's remainder commit) would sweep a deleted repo's whole tree onto
 * the agent's branch, and a land would put it back into /work as ordinary files. */
test("the deleted repo's checkouts are reclaimed out of every conversation, into the trash", async () => {
    const { work, historyRoot, worktrees, agents } = await setup();
    // Something the agent never committed, so the reclaim is not a delete: this is its only copy.
    await writeFile(join(worktrees.conversationDir("c1"), "client", "scratch.ts"), "unfinished\n");
    await rm(join(work, "client"), { recursive: true, force: true });

    await dropVanishedRepos({ agents, agentWorktrees: worktrees, logger });

    for (const id of ["c1", "c2"]) {
        expect(existsSync(join(worktrees.conversationDir(id), "client"))).toBe(false);
        // The conversation's own checkout is untouched: only the dead repo's directory went.
        expect(existsSync(join(worktrees.conversationDir(id), "CLAUDE.md"))).toBe(true);
    }
    const trashed = await readdir(join(historyRoot, "trash"));
    expect(trashed).toHaveLength(2);
    expect(trashed.every((entry) => entry.startsWith("client-"))).toBe(true);
    expect(existsSync(join(historyRoot, "trash", trashed.find((entry) => entry.includes("c1")) ?? "", "scratch.ts"))).toBe(true);
});

/* THE SAFETY PROPERTY, and the reason the repo-set frame is a trigger rather than an authority: discovery is a
 * filesystem walk that answers with whatever it could read, so a momentary failure reports a shrunken
 * workspace, and a repo can stop being discovered while its files sit right there. Acting on either reading
 * would strip live repos out of every conversation on the board, which is far worse than the bug being fixed.
 * Only a directory that is GONE is a deletion; a repo that has merely stopped being a repo keeps its row, and
 * every per-repo pass tolerates it. */
test("a repo that stopped being a repo but kept its files is never dropped", async () => {
    const { work, worktrees, agents } = await setup();
    // What the weaker "git will not answer here" test would have called a deletion: no .git, all the files.
    await rm(join(work, "client", ".git"), { recursive: true, force: true });

    expect(await dropVanishedRepos({ agents, agentWorktrees: worktrees, logger })).toEqual([]);

    expect(reposOf(agents, "c1")).toEqual(["root", "client"]);
    expect(existsSync(join(worktrees.conversationDir("c1"), "client"))).toBe(true);
    expect(existsSync(join(work, "client", "index.ts"))).toBe(true);
});
