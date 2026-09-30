import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isolatedAgent, noIsolation } from "../../testing.js";
import { ensureRootRepo } from "../../git/remote/root-repo.js";
import { createLogger } from "../../logger.js";
import { createPerfTracker } from "../../system/resources/perf.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { carriedRef, dropAgentRef } from "../land/agent-refs.js";
import { landAgent } from "../land/land.js";
import { carryStrayWork, snapshotRefs, strayStandings } from "./stray-work.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "./worktrees.js";

// Pins the carry of a turn's work off a branch of its own: what counts as the turn's (and what never does), that the
// copy is never moved, and that what a land reads afterwards holds it.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = async (cwd: string, message: string): Promise<string> => {
    await sh(cwd, "add", "-A");
    await sh(cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", message);
    return sh(cwd, "rev-parse", "HEAD");
};
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const ID = "c1";
const OWN = `agent/${ID}`;

// A main tree with one file, a conversation's copy of it, and `origin/main` one commit ahead of the main tree, which is
// what a branch cut from the remote carries and this conversation never wrote.
const setup = async (): Promise<{ work: string; worktrees: AgentWorktrees; conversation: ConversationWorktree; cwd: string }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-stray-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "app.ts"), "one\ntwo\nthree\n");
    await commit(work, "baseline");
    await writeFile(join(work, "remote-only.ts"), "pushed by someone else\n");
    await sh(work, "update-ref", "refs/remotes/origin/main", await commit(work, "remote only"));
    await sh(work, "reset", "-q", "--hard", "HEAD~1");
    const worktrees = createAgentWorktrees({
        workspace,
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: noIsolation(work, historyRoot),
        logger,
        perf,
    });
    const conversation = await worktrees.ensure(ID, []);
    return { work, worktrees, conversation, cwd: conversation.cwd };
};

test("carries what the turn committed on a branch cut from the remote onto agent/<id>, and leaves the copy there", async () => {
    const { work, worktrees, conversation, cwd } = await setup();
    const snapshot = await snapshotRefs(worktrees, conversation.repos);
    await sh(cwd, "checkout", "-q", "-B", "ci/fix", "origin/main");
    await writeFile(join(cwd, "app.ts"), "one\ntwo EDITED\nthree\n");
    const made = await commit(cwd, "fix two");

    const carries = await carryStrayWork(worktrees, ID, conversation.repos, snapshot);

    expect(carries).toEqual([{ repo: "root", branch: "ci/fix", carried: 1 }]);
    expect(await sh(cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ci/fix");
    expect(await sh(cwd, "rev-parse", "HEAD")).toBe(made);
    expect(await sh(work, "show", `${OWN}:app.ts`)).toBe("one\ntwo EDITED\nthree");
    expect(await sh(work, "log", "-1", "--format=%s%n%an", OWN)).toBe("fix two\na");
    // origin/main's own commit is the other branch's history, not this turn's work.
    await expect(sh(work, "cat-file", "-e", `${OWN}:remote-only.ts`)).rejects.toThrow();
    expect(await strayStandings(worktrees, ID, conversation.repos)).toEqual([{ repo: "root", branch: "ci/fix", carried: true, uncommitted: false }]);

    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(landed.changed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("one\ntwo EDITED\nthree\n");
});

test("a branch that existed before the turn keeps its own history to itself", async () => {
    const { work, worktrees, conversation, cwd } = await setup();
    await sh(work, "branch", "feature", "HEAD");
    const feature = join(work, "feature-wt");
    await sh(work, "worktree", "add", "-q", feature, "feature");
    await writeFile(join(feature, "feature.ts"), "the owner's own\n");
    await commit(feature, "owner's feature work");
    await sh(work, "worktree", "remove", "--force", feature);
    const snapshot = await snapshotRefs(worktrees, conversation.repos);
    await sh(cwd, "checkout", "-q", "feature");
    await writeFile(join(cwd, "app.ts"), "one\ntwo\nthree EDITED\n");
    await commit(cwd, "asked-for fix on feature");

    const carries = await carryStrayWork(worktrees, ID, conversation.repos, snapshot);

    expect(carries).toEqual([{ repo: "root", branch: "feature", carried: 1 }]);
    expect(await sh(work, "log", "--format=%s", `HEAD..${OWN}`)).toBe("asked-for fix on feature");
    await expect(sh(work, "cat-file", "-e", `${OWN}:feature.ts`)).rejects.toThrow();
});

test("carries each turn's commits once: a second carry adds nothing, the next turn only its own", async () => {
    const { work, worktrees, conversation, cwd } = await setup();
    const first = await snapshotRefs(worktrees, conversation.repos);
    await sh(cwd, "checkout", "-q", "-b", "side");
    await writeFile(join(cwd, "a.ts"), "a\n");
    await commit(cwd, "turn one");
    await carryStrayWork(worktrees, ID, conversation.repos, first);

    expect(await carryStrayWork(worktrees, ID, conversation.repos, first)).toEqual([{ repo: "root", branch: "side", carried: 0 }]);

    const second = await snapshotRefs(worktrees, conversation.repos);
    await writeFile(join(cwd, "b.ts"), "b\n");
    await commit(cwd, "turn two");
    expect(await carryStrayWork(worktrees, ID, conversation.repos, second)).toEqual([{ repo: "root", branch: "side", carried: 1 }]);
    expect((await sh(work, "log", "--format=%s", `HEAD..${OWN}`)).split("\n")).toEqual(["turn two", "turn one"]);
});

test("a commit that does not replay onto agent/<id> moves nothing, and the review is told it is stranded", async () => {
    const { work, worktrees, conversation, cwd } = await setup();
    await writeFile(join(cwd, "app.ts"), "one\nOURS\nthree\n");
    const own = await commit(cwd, "on agent branch");
    const snapshot = await snapshotRefs(worktrees, conversation.repos);
    await sh(cwd, "checkout", "-q", "-B", "ci/fix", "origin/main");
    await writeFile(join(cwd, "app.ts"), "one\nTHEIRS\nthree\n");
    await commit(cwd, "clashing fix");

    const [carry] = await carryStrayWork(worktrees, ID, conversation.repos, snapshot);

    expect(carry).toMatchObject({ repo: "root", branch: "ci/fix", carried: 0 });
    expect(carry?.refused).toMatch(/does not apply onto agent\/c1: app\.ts$/);
    expect(await sh(work, "rev-parse", OWN)).toBe(own);
    await expect(sh(work, "rev-parse", "-q", "--verify", carriedRef(OWN))).rejects.toThrow();
    expect(await strayStandings(worktrees, ID, conversation.repos)).toEqual([{ repo: "root", branch: "ci/fix", carried: false, uncommitted: false }]);
});

test("with no record of the refs the turn opened on, nothing is carried: it cannot tell the turn's commits from the branch's", async () => {
    const { work, worktrees, conversation, cwd } = await setup();
    const before = await sh(work, "rev-parse", OWN);
    await sh(cwd, "checkout", "-q", "-B", "ci/fix", "origin/main");
    await writeFile(join(cwd, "c.ts"), "c\n");
    await commit(cwd, "fix");

    const carries = await carryStrayWork(worktrees, ID, conversation.repos, new Map());

    expect(carries).toEqual([{ repo: "root", branch: "ci/fix", carried: 0, refused: "no record of its refs as the turn opened" }]);
    expect(await sh(work, "rev-parse", OWN)).toBe(before);
});

test("a copy on its own branch has nothing to carry, and uncommitted edits on another are said", async () => {
    const { worktrees, conversation, cwd } = await setup();
    const snapshot = await snapshotRefs(worktrees, conversation.repos);
    await writeFile(join(cwd, "app.ts"), "one\ntwo\nthree\nfour\n");
    expect(await carryStrayWork(worktrees, ID, conversation.repos, snapshot)).toEqual([]);
    expect(await strayStandings(worktrees, ID, conversation.repos)).toEqual([]);

    await sh(cwd, "checkout", "-q", "-b", "side");
    await carryStrayWork(worktrees, ID, conversation.repos, snapshot);
    expect(await strayStandings(worktrees, ID, conversation.repos)).toEqual([{ repo: "root", branch: "side", carried: true, uncommitted: true }]);
});

test("dropping the conversation's branch drops its carry marker with it", async () => {
    const { work, worktrees, conversation, cwd } = await setup();
    const snapshot = await snapshotRefs(worktrees, conversation.repos);
    await sh(cwd, "checkout", "-q", "-b", "side");
    await carryStrayWork(worktrees, ID, conversation.repos, snapshot);
    expect(await sh(work, "rev-parse", "-q", "--verify", carriedRef(OWN))).toBe(await sh(cwd, "rev-parse", "HEAD"));

    await dropAgentRef(work, OWN, (dir, args) => exec("git", ["-C", dir, ...args]));

    await expect(sh(work, "rev-parse", "-q", "--verify", carriedRef(OWN))).rejects.toThrow();
});
