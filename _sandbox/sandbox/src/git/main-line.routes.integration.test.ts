import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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

test("the main line latched by hand is the one kept", async () => {
    const workspace = sharedRepo();
    git(workspace.root, "config", MAIN_BRANCH_CONFIG, "feature");
    git(workspace.root, "checkout", "-q", "feature");
    const client = appOn(workspace);
    expect((await client.git.checkout({ repo: "root", ref: "main" })).ok).toBe(false);
    expect(await client.git.checkout({ repo: "root", ref: "feature" })).toEqual({ ok: true });
});
