import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../app.js";
import { workspacePaths } from "../workspace/workspace.js";
import { clientFor, errorCode } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { changedFiles } from "./changes/changes.js";
import { checkoutRef } from "./changes/changes-commits.js";
import { createBranch } from "./ops/branches.js";
import { MAIN_BRANCH_CONFIG } from "./main-line-lock.js";
import { plainCheckoutRefusal } from "./main-line.routes.js";
import { linkLayoutOf } from "../workspace/layout/worktree-links.js";

// The shared checkout stays on its main line (main-line-lock.ts): the routes that would move it refuse before writing,
// the scan names a checkout something moved anyway, and the way back puts it on its line. Real git on a real repo, since
// what is under test is where HEAD ends up.

const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

const sharedRepo = (): ReturnType<typeof workspacePaths> => {
    const root = mkdtempSync(join(tmpdir(), "main-line-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, "add", "a.txt");
    git(root, "commit", "-qm", "a");
    git(root, "branch", "feature");
    return workspacePaths(root);
};

const appOn = (workspace: ReturnType<typeof workspacePaths>) =>
    clientFor(createApp(services({ workspace, git: { ...services().git, checkoutRef, createBranch, changedFiles } })));

test("a checkout off the main line is refused before anything moves, and one onto it goes through", async () => {
    const workspace = sharedRepo();
    const client = appOn(workspace);
    const refused = await client.git.checkout({ repo: "root", ref: "feature" });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("stays on `main`");
    expect(git(workspace.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    // Latched where the shell's wrapper and the agent guard read it too.
    expect(git(workspace.root, "config", "--get", MAIN_BRANCH_CONFIG)).toBe("main");
    expect(await client.git.checkout({ repo: "root", ref: "main" })).toEqual({ ok: true });
});

test("a new branch is made where asked but never switched to", async () => {
    const workspace = sharedRepo();
    const client = appOn(workspace);
    expect(await errorCode(client.git.createBranchAt({ repo: "root", name: "topic", checkout: true }))).toBe("PRECONDITION_FAILED");
    expect(git(workspace.root, "branch", "--list", "topic")).toBe("");
    expect(await client.git.createBranchAt({ repo: "root", name: "topic" })).toEqual({ ok: true });
    expect(git(workspace.root, "branch", "--list", "topic")).toContain("topic");
    expect(git(workspace.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
});

test("a checkout moved off its line anyway is named on the scan, clean or not, and the way back returns it", async () => {
    const workspace = sharedRepo();
    const client = appOn(workspace);
    expect((await client.git.changes()).repos).toEqual([]);
    git(workspace.root, "checkout", "-q", "feature");
    const [row] = (await clientFor(createApp(services({ workspace, git: { ...services().git, changedFiles } }))).git.changes()).repos;
    expect(row).toMatchObject({ repo: "root", branch: "feature", mainBranch: "main" });
    expect(await client.git.returnToMainLine({ repo: "root" })).toEqual({ ok: true });
    expect(git(workspace.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    // Already there: nothing to do, and said as done.
    expect(await client.git.returnToMainLine({ repo: "root" })).toEqual({ ok: true });
});

// targowisko, 2026-11-11: the shared checkout linked into the home conversation's worktree record, and "Back to main"
// answered only git's "'main' is already used by worktree". The way back now undoes the link instead.
test("the way back undoes a shared checkout linked into a conversation's worktree record", async () => {
    const base = mkdtempSync(join(tmpdir(), "main-line-hijack-"));
    const work = join(base, "work");
    const worktreesRoot = join(base, "worktrees");
    mkdirSync(work, { recursive: true });
    mkdirSync(join(base, "gits"), { recursive: true });
    git(work, "init", "-q", "-b", "main", "--separate-git-dir", join(base, "gits", "root"));
    git(work, "config", "user.email", "t@example.com");
    git(work, "config", "user.name", "t");
    writeFileSync(join(work, "a.txt"), "a\n");
    git(work, "add", "a.txt");
    git(work, "commit", "-qm", "a");
    const home = join(worktreesRoot, "home");
    git(work, "worktree", "add", "-q", "-b", "agent/home", home);
    const admin = readFileSync(join(home, ".git"), "utf8").replace(/^gitdir:\s*/u, "").trim();
    writeFileSync(join(admin, "gitdir"), `${join(work, ".git")}\n`);
    git(work, "worktree", "repair");
    expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe("agent/home");
    const workspace = workspacePaths(work);
    const agentWorktrees = { ...services().agentWorktrees, ...linkLayoutOf(work, worktreesRoot) };
    const client = clientFor(createApp(services({ workspace, agentWorktrees, git: { ...services().git, checkoutRef, changedFiles } })));

    expect(await client.git.returnToMainLine({ repo: "root" })).toEqual({ ok: true });
    expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(home, "symbolic-ref", "--short", "HEAD")).toBe("agent/home");
});

test("the way back detaches a conversation's checkout that took the main line, moving none of its files", async () => {
    const workspace = sharedRepo();
    const copy = join(mkdtempSync(join(tmpdir(), "main-line-copy-")), "c1");
    git(workspace.root, "worktree", "add", "-q", "-b", "agent/c1", copy);
    git(workspace.root, "checkout", "-q", "feature");
    git(copy, "switch", "-q", "main");
    writeFileSync(join(copy, "a.txt"), "the agent's edit\n");
    const client = appOn(workspace);

    expect(await client.git.returnToMainLine({ repo: "root" })).toEqual({ ok: true });
    expect(git(workspace.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(() => git(copy, "symbolic-ref", "-q", "HEAD")).toThrow();
    expect(readFileSync(join(copy, "a.txt"), "utf8")).toBe("the agent's edit\n");
});

test("git's refusal over a worktree holding the main line is said as what it means", () => {
    expect(plainCheckoutRefusal("fatal: 'main' is already used by worktree at '/history/gits/app'", "main")).toBe(
        "`main` is still checked out at /history/gits/app, so the workspace cannot take it back. Stop or archive the conversation working there, then try again.",
    );
    expect(plainCheckoutRefusal("error: Your local changes would be overwritten", "main")).toBe("error: Your local changes would be overwritten");
});

test("the main line latched by hand is the one kept", async () => {
    const workspace = sharedRepo();
    git(workspace.root, "config", MAIN_BRANCH_CONFIG, "feature");
    git(workspace.root, "checkout", "-q", "feature");
    const client = appOn(workspace);
    expect((await client.git.checkout({ repo: "root", ref: "main" })).ok).toBe(false);
    expect(await client.git.checkout({ repo: "root", ref: "feature" })).toEqual({ ok: true });
});
