import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import { clientFor, errorCode } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { runAgentTurn } from "../harness/route-turns.testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { deleteBranch } from "./ops/branches.js";

// Deleting a branch the daemon keeps a checkout of (conversations/worktrees/branches/branch-checkouts.ts): one only looked at goes
// with its checkout, and one a live conversation was started from stays, since its land goes there (main-line.routes.ts).

const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

const shared = (): ReturnType<typeof workspacePaths> => {
    const root = mkdtempSync(join(tmpdir(), "branch-delete-"));
    roots.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, "add", "a.txt");
    git(root, "commit", "-qm", "a");
    git(root, "branch", "feature");
    git(root, "branch", "looked-at");
    return workspacePaths(root);
};

const daemonOn = (workspace: ReturnType<typeof workspacePaths>) => services({ workspace, git: { ...services().git, deleteBranch } });

test("a branch only looked at goes, its checkout first", async () => {
    const workspace = shared();
    const daemon = daemonOn(workspace);
    const client = clientFor(createApp(daemon));
    await daemon.branchCheckouts.ensure("root", "looked-at");
    expect(await client.git.deleteBranch({ repo: "root", name: "looked-at" })).toEqual({ ok: true });
    expect(git(workspace.root, "branch", "--list", "looked-at")).toBe("");
    expect(await daemon.branchCheckouts.standing()).toEqual([]);
});

test("a branch a live conversation was started from stays while that conversation does", async () => {
    const workspace = shared();
    const daemon = daemonOn(workspace);
    const client = clientFor(createApp(daemon));
    await runAgentTurn(client, { prompt: "work on it", conversationId: "from-branch", isolated: true, fromBranch: { repo: "root", branch: "feature" } });
    expect(await errorCode(client.git.deleteBranch({ repo: "root", name: "feature", force: true }))).toBe("PRECONDITION_FAILED");
    expect(git(workspace.root, "branch", "--list", "feature")).toContain("feature");
    expect(await daemon.branchCheckouts.standing()).toEqual([{ repo: "root", branch: "feature" }]);
});
