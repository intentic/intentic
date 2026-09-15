import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { isolatedAgent, noIsolation } from "../../testing.js";
import { ensureRootRepo } from "../../git/remote/root-repo.js";
import { createLogger } from "../../logger.js";
import { createPerfTracker } from "../../platform/resources/perf.js";
import { workspacePaths } from "../../workspace/workspace.js";
import type { IsolatedAgent } from "../registry/agents-store.js";
import { landAgent } from "./land.js";
import { createLandStandings } from "./standing.js";
import { syncConversation } from "./sync.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "../worktrees/worktrees.js";

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

const setup = async (): Promise<{ work: string; worktrees: AgentWorktrees; conversation: ConversationWorktree }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-standing-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "app.ts"), "line one\nline two\nline three\n");
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
    return { work, worktrees, conversation: await worktrees.ensure("c1", []) };
};

// One conflict report shaped like a refused land's; only whether the standing lets it speak matters here.
const report = [{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" as const }], clean: 0 }];

const standingOf = async (worktrees: AgentWorktrees, entry: IsolatedAgent): Promise<string> => {
    const standings = createLandStandings(worktrees);
    await standings.refresh([entry]);
    return standings.of(entry.id);
};

test("an agent with nothing on its branch is idle; one whose work landed reads landed", async () => {
    const { worktrees, conversation } = await setup();
    expect(await standingOf(worktrees, isolatedAgent(conversation.repos))).toBe("idle");

    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(await standingOf(worktrees, isolatedAgent(landed.repos))).toBe("landed");
});

test("work held on the branch reads ready, and a refused land makes the same delta a conflict", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");

    expect(await standingOf(worktrees, isolatedAgent(conversation.repos))).toBe("ready");
    // Same delta: only the entry's stored refusal differs between `ready` and `conflict` here.
    expect(await standingOf(worktrees, isolatedAgent(conversation.repos, { conflicts: report }))).toBe("conflict");
});

// Derived, the stale-conflict case cannot arise: `conflict` has a premise, an outstanding delta, and merging the branch
// removes it whatever the stored report still says.
test("a conflict report cannot outlive its delta: work merged into main by hand reads landed", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    const stranded = isolatedAgent(conversation.repos, { conflicts: report });
    expect(await standingOf(worktrees, stranded)).toBe("conflict");

    // The daemon sees none of this; the entry still carries the report and no landedTip.
    await sh(work, "merge", "--ff-only", "agent/c1");

    expect(await standingOf(worktrees, stranded)).toBe("landed");
});

test("a standing is re-derived when either the branch or the main tree moves", async () => {
    const { work, worktrees, conversation } = await setup();
    const standings = createLandStandings(worktrees);
    const entry = isolatedAgent(conversation.repos);
    await standings.refresh([entry]);
    expect(standings.of("c1")).toBe("idle");

    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    expect(await standings.refresh([entry])).toBe(true);
    expect(standings.of("c1")).toBe("ready");

    // Main moving is the other half: the sha the anchor is measured against.
    await sh(work, "merge", "--ff-only", "agent/c1");
    expect(await standings.refresh([entry])).toBe(true);
    expect(standings.of("c1")).toBe("landed");

    // A pass over unchanged shas costs nothing and reports nothing to publish.
    expect(await standings.refresh([entry])).toBe(false);
});

// A land moves neither HEAD nor the tip, only the entry's `landedTip`, the rung `anchorOf` measures from; a cache keyed
// on the two shas alone would still serve the pre-land answer.
test("a land re-derives on the spot, even though neither sha moved", async () => {
    const { worktrees, conversation } = await setup();
    const standings = createLandStandings(worktrees);
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    const entry = isolatedAgent(conversation.repos);
    await standings.refresh([entry]);
    expect(standings.of("c1")).toBe("ready");

    const landed = await landAgent(worktrees, entry);
    expect(landed.landed).toBe(true);

    expect(await standings.refresh([isolatedAgent(landed.repos)])).toBe(true);
    expect(standings.of("c1")).toBe("landed");
});

// A refusal changes nothing but the stored report; the shas underneath stay exactly what they were.
test("a refused land arms the conflict against the same shas", async () => {
    const { work, worktrees, conversation } = await setup();
    const standings = createLandStandings(worktrees);
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    const entry = isolatedAgent(conversation.repos);
    await standings.refresh([entry]);
    expect(standings.of("c1")).toBe("ready");

    // The user edits the same lines the agent did, so the delta no longer applies.
    await writeFile(join(work, "app.ts"), "line one MINE\nline two\nline three\n");
    const refused = await landAgent(worktrees, entry);
    expect(refused.landed).toBe(false);

    expect(await standings.refresh([isolatedAgent(refused.repos, { conflicts: refused.conflicts })])).toBe(true);
    expect(standings.of("c1")).toBe("conflict");
});

// The one refusal whose premise this file's header could not cover: `workspace` is caused by the user's own uncommitted
// edits, which move no sha and touch no stored report, so nothing else here notices when they go. Doing exactly what the
// report asked has to clear the card by itself — no second land, no press.
test("clearing the uncommitted edit a refusal named puts the card back to ready, with nothing re-landed", async () => {
    const { work, worktrees, conversation } = await setup();
    const standings = createLandStandings(worktrees);
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");

    await writeFile(join(work, "app.ts"), "line one MINE\nline two\nline three\n");
    const refused = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(refused.conflicts?.[0]?.paths).toEqual([{ path: "app.ts", reason: "workspace" }]);
    const entry = isolatedAgent(refused.repos, { conflicts: refused.conflicts });
    await standings.refresh([entry]);
    expect(standings.of("c1")).toBe("conflict");
    // Named, not just counted: the board offers a press per cause, and this is the one only the user can make.
    expect(standings.causesOf("c1")).toEqual(["workspace"]);

    // The user does what the report asked and nothing else: no commit, no land, not a sha moves.
    await sh(work, "checkout", "--", "app.ts");

    expect(await standings.refresh([entry])).toBe(true);
    expect(standings.of("c1")).toBe("ready");
    expect(standings.causesOf("c1")).toEqual([]);
});

// The conservative half of the same reading: a tidy tree is evidence about `workspace` blockers and nothing else, so a
// committed divergence keeps refusing until a land re-judges it.
test("a refusal the workspace never caused survives a tidy tree", async () => {
    const { work, worktrees, conversation } = await setup();
    const standings = createLandStandings(worktrees);
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    const entry = isolatedAgent(conversation.repos, { conflicts: report });
    await standings.refresh([entry]);
    expect(standings.of("c1")).toBe("conflict");
    expect(standings.causesOf("c1")).toEqual(["diverged"]);

    // Unrelated edits of the user's, made and unmade: the tree is as clean as it was, and so is the verdict.
    await writeFile(join(work, "notes.md"), "mine\n");
    await standings.refresh([entry]);
    await rm(join(work, "notes.md"));

    await standings.refresh([entry]);
    expect(standings.of("c1")).toBe("conflict");
    expect(standings.causesOf("c1")).toEqual(["diverged"]);
});

// Per-cause, not all-or-nothing: clearing your own half of a mixed refusal narrows what is left rather than clearing it,
// which is what lets the card swap "commit yours" for "have the agent resolve it" at exactly the right moment.
test("clearing the user's half of a mixed refusal leaves the agent's half standing", async () => {
    const { work, worktrees, conversation } = await setup();
    const standings = createLandStandings(worktrees);
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    await writeFile(join(work, "mine.ts"), "mine\n");
    const mixed = [
        {
            repo: "root",
            paths: [
                { path: "mine.ts", reason: "workspace" as const },
                { path: "app.ts", reason: "diverged" as const },
            ],
            clean: 0,
        },
    ];
    const entry = isolatedAgent(conversation.repos, { conflicts: mixed });
    await standings.refresh([entry]);
    expect(standings.causesOf("c1")).toEqual(["workspace", "diverged"]);

    await rm(join(work, "mine.ts"));

    expect(await standings.refresh([entry])).toBe(true);
    expect(standings.of("c1")).toBe("conflict");
    expect(standings.causesOf("c1")).toEqual(["diverged"]);
});

// Commits are dropped one by one, only when each is empty on its own, so a pair that cancels out survives a rebase and
// leaves the branch ahead with nothing real in it.
test("a branch ahead by commits that cancel out is landed, not ready", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(landed.landed).toBe(true);

    // Cancelling each other out: a generated file regenerated, then put back.
    await writeFile(join(conversation.cwd, "lock.json"), "regenerated\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "chore: regenerate the lock");
    await rm(join(conversation.cwd, "lock.json"));
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "chore: put the lock back");

    // Sync rebases onto the user's commit, dropping the agent's work commit but keeping the cancelling pair.
    await sh(work, "add", "-A");
    await commit(work, "user reviews and commits");
    await syncConversation(worktrees, "c1", conversation.repos, "Warm pool");
    expect(await sh(conversation.cwd, "rev-parse", "HEAD^^")).toBe(await sh(work, "rev-parse", "HEAD"));

    // Nothing to land: the entry's landedTip is the sha rebase orphaned, the anchor a sha-only reading used to trust.
    const rebased = isolatedAgent(landed.repos);
    expect(await standingOf(worktrees, rebased)).toBe("landed");

    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three MORE\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "more agent work");
    expect(await standingOf(worktrees, rebased)).toBe("ready");
});

test("forget drops an agent's standing, and an unprobed one reads idle", async () => {
    const { worktrees, conversation } = await setup();
    const standings = createLandStandings(worktrees);
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    await standings.refresh([isolatedAgent(conversation.repos)]);
    expect(standings.of("c1")).toBe("ready");

    standings.forget(["c1"]);
    // The resting answer, so a discarded agent never flashes through Attention on its way off the board.
    expect(standings.of("c1")).toBe("idle");
});

// A deleted branch is not an outstanding delta; reporting one would offer a land with nothing behind it.
test("a repo whose branch has been deleted contributes nothing outstanding", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    const entry = isolatedAgent(conversation.repos, { conflicts: report });
    expect(await standingOf(worktrees, entry)).toBe("conflict");

    await worktrees.remove("c1", conversation.repos);
    expect(await standingOf(worktrees, entry)).toBe("idle");
});

// Same reading as a deleted branch: nothing of this agent's is in that repo any more, and it must not fail the rest of
// a multi-repo composition.
test("a repo deleted from the workspace contributes nothing, and cannot fail the pass", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");

    const withDeleted = [...conversation.repos, { repo: "deleted", base: "0".repeat(40) }];
    expect(await standingOf(worktrees, isolatedAgent(withDeleted))).toBe("ready");
    // A composition that is entirely that one deleted repo is idle rather than an exception.
    expect(await standingOf(worktrees, isolatedAgent([{ repo: "deleted", base: "0".repeat(40) }]))).toBe("idle");
});
