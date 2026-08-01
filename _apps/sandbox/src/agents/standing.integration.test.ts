import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { isolatedAgent, noIsolation } from "../testing.js";
import { ensureRootRepo } from "../git/root-repo.js";
import { createLogger } from "../logger.js";
import { createPerfTracker } from "../platform/perf.js";
import { workspacePaths } from "../workspace/workspace.js";
import type { IsolatedAgent } from "./agents-store.js";
import { landAgent } from "./land.js";
import { createLandStandings } from "./standing.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "./worktrees.js";

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

// One conflict report, shaped like the one a refused land records. What it SAYS never matters here — only
// whether the standing lets it speak.
const report = [{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" as const }], clean: 0 }];

const standingOf = async (worktrees: AgentWorktrees, entry: IsolatedAgent): Promise<string> => {
    const standings = createLandStandings(worktrees);
    await standings.refresh([entry]);
    return standings.of(entry.id);
};

test("an agent with nothing on its branch is idle; one whose work landed reads landed", async () => {
    const { worktrees, conversation } = await setup();
    // A turn that produced nothing — answered a question, read some files. The most archivable card there is.
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

    // Outstanding, nothing refused: the deliberate-land queue.
    expect(await standingOf(worktrees, isolatedAgent(conversation.repos))).toBe("ready");
    // The SAME delta, with the last land's refusal on the entry. The report explains a conflict; the delta is
    // what makes there be one.
    expect(await standingOf(worktrees, isolatedAgent(conversation.repos, { conflicts: report }))).toBe("conflict");
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
    const stranded = isolatedAgent(conversation.repos, { conflicts: report });
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
    const entry = isolatedAgent(conversation.repos);
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

/* THE SHAS ARE NOT THE WHOLE QUESTION — and a land is the case that proves it.
 *
 * Landing applies a patch to the main WORKING TREE: main's HEAD does not move, and the branch tip does not
 * either (the provenance commit already happened when the turn ended). The only thing that changes is the
 * entry's `landedTip` — which is the very rung `anchorOf` measures the outstanding delta from. A cache keyed on
 * the two shas alone therefore serves the pre-land answer back, and the board keeps offering "Land now" for
 * work that is already sitting in the user's workspace, until something unrelated moves a sha.
 */
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

// The same property on the failure path: a refused `check` land leaves the workspace byte-identical, so its
// report is the ONLY thing that moved. Serving the cached `ready` there leaves the card promising a land that
// has just been refused, with the report it would have to explain nowhere on screen.
test("a refused land arms the conflict against the same shas", async () => {
    const { work, worktrees, conversation } = await setup();
    const standings = createLandStandings(worktrees);
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    const entry = isolatedAgent(conversation.repos);
    await standings.refresh([entry]);
    expect(standings.of("c1")).toBe("ready");

    // The user edits the same lines, so the delta no longer applies.
    await writeFile(join(work, "app.ts"), "line one MINE\nline two\nline three\n");
    const refused = await landAgent(worktrees, entry);
    expect(refused.landed).toBe(false);

    expect(await standings.refresh([isolatedAgent(refused.repos, { conflicts: refused.conflicts })])).toBe(true);
    expect(standings.of("c1")).toBe("conflict");
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
    const entry = isolatedAgent(conversation.repos, { conflicts: report });
    expect(await standingOf(worktrees, entry)).toBe("conflict");

    await worktrees.remove("c1", conversation.repos);
    expect(await standingOf(worktrees, entry)).toBe("idle");
});
