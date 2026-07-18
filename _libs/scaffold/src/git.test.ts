import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type GitRunner, gitClone, gitCommitAll, gitInit, gitStatus, gitSync } from "./git.js";

// A GitRunner that returns canned stdout per joined-args key and records every invocation.
const recordingGit = (responses: Readonly<Record<string, string>>) => {
    const calls: string[][] = [];
    const git: GitRunner = async (dir, args) => {
        calls.push([dir, ...args]);
        return { stdout: responses[args.join(" ")] ?? "", stderr: "" };
    };
    return { git, calls };
};

test("gitInit creates the worktree dir and the separate git dir's parent, then inits with the pointer-file flag", async () => {
    const historyRoot = await mkdtemp(join(tmpdir(), "intentic-git-test-"));
    await rm(historyRoot, { recursive: true });
    const dir = join(historyRoot, "work", "intent");
    const separateGitDir = join(historyRoot, "gits", "intent");
    const { git, calls } = recordingGit({});
    await gitInit(dir, separateGitDir, git);
    await expect(access(dir)).resolves.toBeUndefined();
    await expect(access(join(historyRoot, "gits"))).resolves.toBeUndefined();
    expect(calls).toEqual([[dir, "init", "-q", "--initial-branch=main", `--separate-git-dir=${separateGitDir}`]]);
    await rm(historyRoot, { recursive: true });
});

test("gitInit with no separate git dir is a plain init", async () => {
    const historyRoot = await mkdtemp(join(tmpdir(), "intentic-git-test-"));
    await rm(historyRoot, { recursive: true });
    const dir = join(historyRoot, "work", "app");
    const { git, calls } = recordingGit({});
    await gitInit(dir, undefined, git);
    await expect(access(dir)).resolves.toBeUndefined();
    expect(calls).toEqual([[dir, "init", "-q", "--initial-branch=main"]]);
    await rm(historyRoot, { recursive: true });
});

test("gitClone forwards the auth header, branch, and separate git dir flags, and creates the git dir's parent", async () => {
    const historyRoot = await mkdtemp(join(tmpdir(), "intentic-git-test-"));
    await rm(historyRoot, { recursive: true });
    const separateGitDir = join(historyRoot, "gits", "extra");
    const { git, calls } = recordingGit({});
    await gitClone(
        "/work",
        "extra",
        "https://example.com/extra.git",
        { branch: "main", authHeader: "Authorization: Basic abc", separateGitDir },
        git,
    );
    expect(calls).toEqual([
        [
            "/work",
            "-c",
            "http.extraheader=Authorization: Basic abc",
            "clone",
            "--branch",
            "main",
            `--separate-git-dir=${separateGitDir}`,
            "https://example.com/extra.git",
            "extra",
        ],
    ]);
    await expect(access(join(historyRoot, "gits"))).resolves.toBeUndefined();
    await rm(historyRoot, { recursive: true });
});

test("gitClone with no options is a bare clone", async () => {
    const { git, calls } = recordingGit({});
    await gitClone("/work", "extra", "https://example.com/extra.git", undefined, git);
    expect(calls).toEqual([["/work", "clone", "https://example.com/extra.git", "extra"]]);
});

test("gitStatus reports branch, dirtiness, and porcelain files", async () => {
    const { git } = recordingGit({ "rev-parse --abbrev-ref HEAD": "main\n", "status --porcelain": " M src/app.ts\n?? new.ts\n" });
    expect(await gitStatus("/work/app", git)).toEqual({ branch: "main", dirty: true, files: ["M src/app.ts", "?? new.ts"] });
});

test("gitStatus on a clean tree is not dirty", async () => {
    const { git } = recordingGit({ "rev-parse --abbrev-ref HEAD": "main\n", "status --porcelain": "\n" });
    expect(await gitStatus("/work/app", git)).toEqual({ branch: "main", dirty: false, files: [] });
});

test("gitCommitAll stages, commits with the author identity, and reports a commit was made", async () => {
    const { git, calls } = recordingGit({ "status --porcelain": " M src/app.ts\n" });
    const committed = await gitCommitAll("/work/app", "agent edit", { name: "intentic", email: "agent@intentic.dev" }, git);
    expect(committed).toBe(true);
    expect(calls).toContainEqual(["/work/app", "add", "-A"]);
    expect(calls).toContainEqual(["/work/app", "-c", "user.name=intentic", "-c", "user.email=agent@intentic.dev", "commit", "-m", "agent edit"]);
});

test("gitCommitAll is a no-op (returns false, never commits) on a clean tree", async () => {
    const { git, calls } = recordingGit({ "status --porcelain": "" });
    const committed = await gitCommitAll("/work/app", "agent edit", { name: "intentic", email: "agent@intentic.dev" }, git);
    expect(committed).toBe(false);
    expect(calls.some((call) => call.includes("commit"))).toBe(false);
});

// Canned git output for a repo that is `behind` upstream and `ahead` of it, on branch origin/main.
const syncResponses = (behind: number, ahead: number, extra: Readonly<Record<string, string>> = {}) => ({
    remote: "origin\n",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main\n",
    "rev-list --left-right --count @{u}...HEAD": `${behind}\t${ahead}\n`,
    ...extra,
});

test("gitSync fast-forwards a clean tree that is strictly behind", async () => {
    const { git, calls } = recordingGit(syncResponses(2, 0, { "status --porcelain": "", "rev-parse --short HEAD": "abc1234\n" }));
    expect(await gitSync("/work/app", git)).toEqual({ status: "updated", behind: 2, head: "abc1234" });
    expect(calls).toContainEqual(["/work/app", "fetch", "--quiet", "origin"]);
    expect(calls).toContainEqual(["/work/app", "merge", "--ff-only", "--quiet", "@{u}"]);
});

test("gitSync leaves a dirty tree untouched and reports it behind", async () => {
    const { git, calls } = recordingGit(syncResponses(2, 0, { "status --porcelain": " M src/app.ts\n" }));
    expect(await gitSync("/work/app", git)).toEqual({ status: "dirty", behind: 2 });
    expect(calls.some((call) => call.includes("merge"))).toBe(false);
});

test("gitSync does not fast-forward a diverged tree (unpushed local commits)", async () => {
    const { git, calls } = recordingGit(syncResponses(1, 3, { "status --porcelain": "" }));
    expect(await gitSync("/work/app", git)).toEqual({ status: "diverged", ahead: 3, behind: 1 });
    expect(calls.some((call) => call.includes("merge"))).toBe(false);
});

test("gitSync reports current when the tree is not behind", async () => {
    const { git, calls } = recordingGit(syncResponses(0, 0));
    expect(await gitSync("/work/app", git)).toEqual({ status: "current" });
    expect(calls.some((call) => call.includes("status"))).toBe(false);
});

test("gitSync skips a repo with no origin (never fetches)", async () => {
    const { git, calls } = recordingGit({ remote: "\n" });
    expect(await gitSync("/work/intent", git)).toEqual({ status: "no-remote" });
    expect(calls.some((call) => call.includes("fetch"))).toBe(false);
});

test("gitSync skips a detached / upstream-less checkout after fetching", async () => {
    const { git, calls } = recordingGit({ remote: "origin\n", "rev-parse --abbrev-ref --symbolic-full-name @{u}": "" });
    expect(await gitSync("/work/app", git)).toEqual({ status: "no-remote" });
    expect(calls).toContainEqual(["/work/app", "fetch", "--quiet", "origin"]);
    expect(calls.some((call) => call.includes("merge"))).toBe(false);
});
