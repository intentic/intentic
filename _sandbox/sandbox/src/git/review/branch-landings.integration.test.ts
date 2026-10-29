import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.js";
import { clientFor, errorCode, proven, rejectForbidden } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { memoryAreasStore } from "../../harness/route-stores.testing.js";
import { withConversationTrailer } from "../../git-identity.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { commitChanges } from "../changes/changes-commits.js";
import { commitFileDiff } from "../changes/changes-diff.js";

const roots: string[] = [];
const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
afterEach(() => {
    for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); }
});

const commit = (dir: string, content: string, session?: string): string => {
    writeFileSync(join(dir, "a.txt"), content);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", session === undefined ? "Owner's edit" : withConversationTrailer(`Agent: ${session}`, session));
    return git(dir, "rev-parse", "HEAD");
};

const setup = (nested = false) => {
    const work = mkdtempSync(join(tmpdir(), "branch-landings-"));
    roots.push(work);
    const repo = nested ? join(work, "lib") : work;
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "user.email", "t@example.com");
    const base = commit(repo, "base\n", "inherited-session");
    git(repo, "branch", "feature");
    const daemon = services({ workspace: workspacePaths(work), git: { ...services().git, commitChanges, commitFileDiff } });
    const client = clientFor(createApp(daemon));
    return { work, repo, base, daemon, client, id: nested ? "lib" : "root" };
};

test("selected branch lists only its session landings and opens the exact parent-to-landing diff", async () => {
    const { repo, base, daemon, client, id } = setup();
    const checkout = await daemon.branchCheckouts.refresh(id, "feature");
    const first = commit(checkout, "first session\n", "first-session");
    commit(checkout, "owner's later edit\n");
    const second = commit(checkout, "second session\n", "second-session");
    writeFileSync(join(repo, "a.txt"), "uncommitted owner work\n");

    const result = await client.git.branchLandings({ repo: id, branch: "feature" });
    expect(result).toEqual({
        mainBranch: "main",
        commits: [
            { sha: second, short: git(checkout, "rev-parse", "--short", second), subject: "Agent: second-session", at: Number(git(checkout, "show", "-s", "--format=%ct", second)) * 1000, agent: "second-session" },
            { sha: first, short: git(checkout, "rev-parse", "--short", first), subject: "Agent: first-session", at: Number(git(checkout, "show", "-s", "--format=%ct", first)) * 1000, agent: "first-session" },
        ],
    });
    expect(await client.git.commitDiff({ repo: id, sha: second })).toEqual({ files: [{ path: "a.txt", status: "modified", additions: 1, deletions: 1 }] });
    expect(await client.git.commitFileDiff({ repo: id, sha: second, path: "a.txt" })).toEqual({ before: "owner's later edit\n", after: "second session\n" });
    expect(await client.git.commitFileDiff({ repo: id, sha: first, path: "a.txt" })).toEqual({ before: "base\n", after: "first session\n" });
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);
    expect(git(repo, "diff")).toContain("+uncommitted owner work");
});

test("a nested repository's branch is read independently of the workspace repository", async () => {
    const { repo, daemon, client, id } = setup(true);
    const checkout = await daemon.branchCheckouts.refresh(id, "feature");
    const sha = commit(checkout, "nested landing\n", "nested-session");
    const result = await client.git.branchLandings({ repo: id, branch: "feature" });
    expect(result.commits.map(({ sha: at, agent }) => ({ sha: at, agent }))).toEqual([{ sha, agent: "nested-session" }]);
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
});

test("pagination stays on its commit when a newer session lands and rejects a rewritten cursor", async () => {
    const { repo, base, daemon, client, id } = setup();
    const checkout = await daemon.branchCheckouts.refresh(id, "feature");
    const shas: string[] = [];
    for (let index = 0; index < 52; index += 1) { shas.push(commit(checkout, `${index}\n`, `session-${index}`)); }
    const first = await client.git.branchLandings({ repo: id, branch: "feature" });
    expect(first.commits.map(({ sha }) => sha)).toEqual(shas.slice(2).toReversed());
    expect(first.next).toBe(shas[2]);
    commit(checkout, "new\n", "new-session");
    const second = await client.git.branchLandings({ repo: id, branch: "feature", before: first.next });
    expect(second.commits.map(({ sha }) => sha)).toEqual(shas.slice(0, 2).toReversed());
    expect(second.next).toBeUndefined();
    git(checkout, "reset", "--hard", base);
    expect(await errorCode(client.git.branchLandings({ repo: id, branch: "feature", before: first.next }))).toBe("PRECONDITION_FAILED");
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
});

test("the branch read keeps the caller's repository fence and rejects invalid scope", async () => {
    const { work } = setup();
    const daemon = services({
        workspace: workspacePaths(work),
        areas: memoryAreasStore([{ id: "support", folders: ["support"] }]),
        auth: { authorize: async () => proven("reader@example.com", "viewer", ["google"], ["support"]), authorizeOwner: rejectForbidden },
    });
    const client = clientFor(createApp(daemon), { bearer: "reader" });
    expect(await errorCode(client.git.branchLandings({ repo: "root", branch: "feature" }))).toBe("FORBIDDEN");
    const owner = clientFor(createApp(services({ workspace: workspacePaths(work) })));
    expect(await errorCode(owner.git.branchLandings({ repo: "root", branch: "main" }))).toBe("BAD_REQUEST");
    expect(await errorCode(owner.git.branchLandings({ repo: "root", branch: "missing" }))).toBe("NOT_FOUND");
    expect(await errorCode(owner.git.branchLandings({ repo: "../escape", branch: "feature" }))).toBe("NOT_FOUND");
});
