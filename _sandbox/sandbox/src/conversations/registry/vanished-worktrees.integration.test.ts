import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { IN_MEMORY } from "@intentic/base/sqlite";
import { unstubbed } from "@intentic/testing";
import type { JournalEntry } from "../../agent/run/turn/turn-journal.js";
import { ensureRootRepo } from "../../git/remote/root-repo.js";
import { createLogger } from "../../logger.js";
import { openConversationsDb } from "../../store/conversations-db.js";
import { createPerfTracker } from "../../system/resources/perf.js";
import { fleetStoreOver, isolatedAgent, memoryFleet, noIsolation } from "../../testing.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { createAgentWorktrees, type AgentWorktrees } from "../worktrees/worktrees.js";
import type { AgentsRegistry } from "./agents-registry.js";
import { worktreeOf } from "./agents-store.js";
import { archiveVanishedWorktrees, type VanishedWorktreeDeps } from "./vanished-worktrees.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

interface Board {
    readonly work: string;
    readonly historyRoot: string;
    readonly worktrees: AgentWorktrees;
    readonly agents: AgentsRegistry;
    readonly reaped: string[];
    readonly running: Set<string>;
    readonly journal: JournalEntry[];
    readonly deps: VanishedWorktreeDeps;
}

// A root repo over /work and `count` idle conversations c1…, each with a real checkout on the history volume.
const board = async (count: number): Promise<Board> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-vanished-worktrees-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "CLAUDE.md"), "workspace notes\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "baseline");
    const worktrees = createAgentWorktrees({
        workspace,
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: noIsolation(work, historyRoot),
        logger,
        perf,
    });
    const store = fleetStoreOver(openConversationsDb(IN_MEMORY));
    const ids = Array.from({ length: count }, (_, index) => `c${index + 1}`);
    const entries = [];
    for (const id of ids) {
        entries.push(isolatedAgent((await worktrees.ensure(id, [])).repos, { id }));
    }
    store.agents.save(entries);
    const { agents } = memoryFleet(store);
    await agents.init();
    const reaped: string[] = [];
    const running = new Set<string>();
    const journal: JournalEntry[] = [];
    const deps: VanishedWorktreeDeps = {
        agents,
        agentWorktrees: worktrees,
        logger,
        conversations: unstubbed<VanishedWorktreeDeps["conversations"]>("conversations", { running: (id) => running.has(id) }),
        reaper: { reapConversation: async (id) => void reaped.push(id) },
        turnJournal: { list: async () => journal },
    };
    return { work, historyRoot, worktrees, agents, reaped, running, journal, deps };
};

// The checkout deleted from disk; `withBranch: false` drops agent/<id> too, so nothing could bring it back.
const lose = async ({ work, worktrees }: Board, id: string, withBranch: boolean): Promise<void> => {
    await rm(worktrees.conversationDir(id), { recursive: true, force: true });
    if (!withBranch) {
        await sh(work, "worktree", "prune");
        await sh(work, "branch", "-D", `agent/${id}`);
    }
};

const archivedIds = (agents: AgentsRegistry): string[] => agents.ids().filter((id) => agents.entry(id)?.archivedAt !== undefined);

// ENOTDIR, EACCES, EIO: the probe failed, which says nothing about whether the checkout is there.
test("a checkout the probe cannot reach is never taken for gone", async () => {
    const it = await board(3);
    // The worktrees root replaced by a file: every checkout path under it answers ENOTDIR, not ENOENT.
    await rename(join(it.historyRoot, "worktrees"), join(it.historyRoot, "worktrees-aside"));
    await writeFile(join(it.historyRoot, "worktrees"), "not a directory\n");

    expect(await archiveVanishedWorktrees(it.deps, 5_000)).toEqual([]);
    expect(archivedIds(it.agents)).toEqual([]);
});

// Six conversations losing their checkouts and branches in the same instant is one outage misread, not six endings.
test("a pass that reads most of the board gone at once archives none of it", async () => {
    const it = await board(6);
    for (const id of it.agents.ids()) {
        await lose(it, id, false);
    }

    expect(await archiveVanishedWorktrees(it.deps, 5_000)).toEqual([]);
    expect(archivedIds(it.agents)).toEqual([]);
});

test("a checkout whose branch survives is left for the next ensure, which re-attaches it", async () => {
    const it = await board(3);
    const repos = worktreeOf(it.agents.entry("c1"))?.repos ?? [];
    await lose(it, "c1", true);

    expect(await archiveVanishedWorktrees(it.deps, 5_000)).toEqual([]);
    expect(archivedIds(it.agents)).toEqual([]);
    const back = await it.worktrees.ensure("c1", repos);
    expect(await sh(back.cwd, "branch", "--show-current")).toBe("agent/c1");
});

// resumeInterruptedTurns runs at the same boot, and an archived conversation is refused the resume.
test("a conversation the boot is resuming, or that is running, is never archived", async () => {
    const it = await board(4);
    await lose(it, "c1", false);
    await lose(it, "c2", false);
    it.journal.push({ kind: "turn", startedAt: 1_000, attempts: 0, turn: { conversationId: "c1", prompt: "go" } });
    it.running.add("c2");

    expect(await archiveVanishedWorktrees(it.deps, 5_000)).toEqual([]);
    expect(archivedIds(it.agents)).toEqual([]);
});

test("a conversation whose checkout and branch are both gone is archived through the archive's own teardown", async () => {
    const it = await board(3);
    await lose(it, "c1", false);

    expect(await archiveVanishedWorktrees(it.deps, 5_000)).toEqual(["c1"]);
    expect(archivedIds(it.agents)).toEqual(["c1"]);
    expect(it.agents.entry("c1")?.archivedAt).toBe(5_000);
    // What the archive's teardown does after the marker, which a bare setArchived skipped.
    expect(it.reaped).toEqual(["c1"]);
});
