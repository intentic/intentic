import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { ensureRootRepo } from "../git/root-repo.js";
import { createLogger } from "../logger.js";
import { workspacePaths } from "../workspace/workspace.js";
import type { PersistedAgent } from "./agents-store.js";
import { landAgent } from "./land.js";
import { createLandStandings } from "./standing.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "./worktrees.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const noIsolation = { available: async () => false, planFor: async () => undefined };

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const setup = async (): Promise<{ work: string; worktrees: AgentWorktrees; conversation: ConversationWorktree }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-standing-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, join(base, "history"));
    await writeFile(join(work, "app.ts"), "line one\nline two\nline three\n");
    await sh(work, "add", "-A");
    await commit(work, "baseline");
    const worktrees = createAgentWorktrees({ workspace, worktreesRoot: join(base, "history", "worktrees"), isolation: noIsolation, logger });
    return { work, worktrees, conversation: await worktrees.ensure("c1", []) };
};

const entryFor = (repos: PersistedAgent["repos"], overrides: Partial<PersistedAgent> = {}): PersistedAgent => ({
    id: "c1",
    branch: "agent/c1",
    title: "fix the thing",
    provider: "claude",
    harness: "native",
    repos: [...repos],
    status: "idle",
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
});

// One conflict report, shaped like the one a refused land records. What it SAYS never matters here — only
// whether the standing lets it speak.
const report = [{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" as const }], clean: 0 }];

const standingOf = async (worktrees: AgentWorktrees, entry: PersistedAgent): Promise<string> => {
    const standings = createLandStandings(worktrees);
    await standings.refresh([entry]);
    return standings.of(entry.id);
};

test("an agent with nothing on its branch is idle; one whose work landed reads landed", async () => {
    const { worktrees, conversation } = await setup();
    // A turn that produced nothing — answered a question, read some files. The most archivable card there is.
    expect(await standingOf(worktrees, entryFor(conversation.repos))).toBe("idle");

    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    const landed = await landAgent(worktrees, entryFor(conversation.repos));
    expect(await standingOf(worktrees, entryFor(landed.repos))).toBe("landed");
});

test("work held on the branch reads ready, and a refused land makes the same delta a conflict", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");

    // Outstanding, nothing refused: the deliberate-land queue.
    expect(await standingOf(worktrees, entryFor(conversation.repos))).toBe("ready");
    // The SAME delta, with the last land's refusal on the entry. The report explains a conflict; the delta is
    // what makes there be one.
    expect(await standingOf(worktrees, entryFor(conversation.repos, { conflicts: report }))).toBe("conflict");
});

/* THE REGRESSION. A conflict verdict used to be written onto the entry and read back forever, so an agent
 * whose work reached the main tree by a road the daemon never drove — a user merging the branch by hand, an
 * agent told to commit onto the main line, a sibling agent's land absorbing the same hunks — kept its card on
 * the last refusal for good. Nothing could clear it: the review panel showed no files (it computes its side
 * fresh), so there was no delta left to land and no conflict left to resolve.
 *
 * Derived, the case cannot arise. `conflict` has a premise — an outstanding delta — and merging the branch is
 * precisely what removes it, whatever the stored report still says. */
test("a conflict report cannot outlive its delta: work merged into main by hand reads landed", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    const stranded = entryFor(conversation.repos, { conflicts: report });
    expect(await standingOf(worktrees, stranded)).toBe("conflict");

    // The user gives up on the button and merges the branch in a terminal. The daemon sees none of it, and the
    // entry still carries the report and no landedTip.
    await sh(work, "merge", "--ff-only", "agent/c1");

    expect(await standingOf(worktrees, stranded)).toBe("landed");
});

// The other half of the same property: a standing is only as old as the shas it was taken against, so a
// re-probe after the branch moves has to see the new work rather than serve the cached answer.
test("a standing is re-derived when either the branch or the main tree moves", async () => {
    const { work, worktrees, conversation } = await setup();
    const standings = createLandStandings(worktrees);
    const entry = entryFor(conversation.repos);
    await standings.refresh([entry]);
    expect(standings.of("c1")).toBe("idle");

    // The agent commits: same entry, new tip.
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    expect(await standings.refresh([entry])).toBe(true);
    expect(standings.of("c1")).toBe("ready");

    // And main moving is the other half — the sha the anchor is measured against.
    await sh(work, "merge", "--ff-only", "agent/c1");
    expect(await standings.refresh([entry])).toBe(true);
    expect(standings.of("c1")).toBe("landed");

    // A pass over unchanged shas costs nothing and reports nothing to publish.
    expect(await standings.refresh([entry])).toBe(false);
});

test("forget drops an agent's standing, and an unprobed one reads idle", async () => {
    const { worktrees, conversation } = await setup();
    const standings = createLandStandings(worktrees);
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    await standings.refresh([entryFor(conversation.repos)]);
    expect(standings.of("c1")).toBe("ready");

    standings.forget(["c1"]);
    // The resting answer — and the one that puts a card in the same lane `landed` would, so a discarded agent
    // never flashes through Attention on its way off the board.
    expect(standings.of("c1")).toBe("idle");
});

// A discarded agent's branch is deleted while its entry may still be read one last time. "The branch is gone"
// is not an outstanding delta, and reporting one would offer a land with nothing behind it.
test("a repo whose branch has been deleted contributes nothing outstanding", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    const entry = entryFor(conversation.repos, { conflicts: report });
    expect(await standingOf(worktrees, entry)).toBe("conflict");

    await worktrees.remove("c1", conversation.repos);
    expect(await standingOf(worktrees, entry)).toBe("idle");
});
