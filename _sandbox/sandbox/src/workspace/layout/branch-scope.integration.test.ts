import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { createApp } from "../../app.js";
import { clientFor, errorCode, proven, rejectForbidden } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { memoryAreasStore } from "../../harness/route-stores.testing.js";
import { openWorkspaceFile, readWorkspaceFileWindow, statWorkspaceFileSize } from "../files/workspace-files.js";
import { listWorkspaceChildren, walkWorkspaceTree } from "../files/workspace-tree.js";
import { fakeFiles } from "../workspace-slice.testing.js";
import { workspacePaths } from "../workspace.js";

// A BRANCH SEEN WITHOUT THE SHARED CHECKOUT LEAVING ITS MAIN LINE (branch-view.ts), over the daemon's own routes and a
// real repository: inside the repository viewed every read is the branch's, a file it deleted included; outside it the
// shared tree answers; nothing in /work moves; and whoever may read the shared tree reads a branch behind the same fence.

const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const write = (dir: string, path: string, text: string): void => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
};
const commitAll = (dir: string, message: string): void => {
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
};

const made: string[] = [];
afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// The workspace on `main` (README, notes, support/faq.md, and a nested repository `lib` it ignores), with `feature` of
// the workspace rewriting the README, deleting the notes and adding a file; `lib` on `main` too, its `topic` rewriting
// src.ts and deleting old.ts, and `remote-only` named only by origin.
const workspaceWithBranches = (): string => {
    const work = mkdtempSync(join(tmpdir(), "branch-scope-"));
    made.push(work);
    git(work, "init", "-q", "-b", "main");
    write(work, ".gitignore", "lib/\n");
    write(work, "README.md", "main readme\n");
    write(work, "notes.md", "main notes\n");
    write(work, "support/faq.md", "how to refund\n");
    commitAll(work, "main");
    git(work, "checkout", "-q", "-b", "feature");
    write(work, "README.md", "feature readme\n");
    rmSync(join(work, "notes.md"));
    write(work, "feature-only.md", "only on feature\n");
    commitAll(work, "feature");
    git(work, "checkout", "-q", "main");
    const lib = join(work, "lib");
    mkdirSync(lib);
    git(lib, "init", "-q", "-b", "main");
    write(lib, "src.ts", "main src\n");
    write(lib, "old.ts", "old\n");
    commitAll(lib, "main");
    git(lib, "checkout", "-q", "-b", "topic");
    write(lib, "src.ts", "topic src\n");
    rmSync(join(lib, "old.ts"));
    commitAll(lib, "topic");
    git(lib, "checkout", "-q", "-b", "gone");
    write(lib, "remote.ts", "from origin\n");
    commitAll(lib, "remote");
    git(lib, "update-ref", "refs/remotes/origin/remote-only", "HEAD");
    git(lib, "checkout", "-q", "main");
    git(lib, "branch", "-D", "-q", "gone");
    return work;
};

// The routes over that workspace with real reads; `actAs` fences the caller to the `support` area.
const routesOver = (work: string) => {
    let caller = proven("ada@example.com", "owner");
    const app = createApp(
        services({
            workspace: workspacePaths(work),
            files: fakeFiles({ readWindow: readWorkspaceFileWindow, open: openWorkspaceFile, size: statWorkspaceFileSize }),
            workspaceTree: (root) => walkWorkspaceTree(root),
            workspaceChildren: listWorkspaceChildren,
            areas: memoryAreasStore([{ id: "support", folders: ["support"] }]),
            auth: { authorize: async () => caller, authorizeOwner: rejectForbidden },
            ownerEmail: async () => "ada@example.com",
        }),
    );
    return {
        app,
        client: clientFor(app, { bearer: "member" }),
        fence: (): void => {
            caller = proven("fay@example.com", "viewer", ["google"], ["support"]);
        },
    };
};

const contentOf = (read: { present: boolean } & { content?: string }): string | undefined => (read.present ? read.content : undefined);

const pathsOf = (entries: readonly WorkspaceTreeEntry[]): string[] => entries.flatMap((entry) => [entry.path, ...pathsOf(entry.children ?? [])]);

test("a branch of the workspace reads as the branch while the shared checkout stays on main, untouched", async () => {
    const work = workspaceWithBranches();
    const { client } = routesOver(work);
    const read = await client.workspace.file({ path: "README.md", branch: "feature" });
    expect(contentOf(read)).toBe("feature readme\n");
    expect(read.present && read.shared).toBe(false);
    expect(contentOf(await client.workspace.file({ path: "feature-only.md", branch: "feature" }))).toBe("only on feature\n");
    expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(work, "README.md"), "utf8")).toBe("main readme\n");
    // The unscoped read is the shared tree's, as ever.
    expect(contentOf(await client.workspace.file({ path: "README.md" }))).toBe("main readme\n");
});

test("a file the branch deleted is not there, however much the shared tree still holds it", async () => {
    const work = workspaceWithBranches();
    const { client } = routesOver(work);
    expect(await client.workspace.file({ path: "notes.md", branch: "feature" })).toEqual({ present: false, path: "notes.md" });
    expect(await client.workspace.file({ path: "lib/old.ts", branch: "topic", repo: "lib" })).toEqual({ present: false, path: "lib/old.ts" });
    expect(contentOf(await client.workspace.file({ path: "notes.md" }))).toBe("main notes\n");
});

test("outside the repository viewed, the shared tree answers, and says so", async () => {
    const work = workspaceWithBranches();
    const { client } = routesOver(work);
    const inside = await client.workspace.file({ path: "lib/src.ts", branch: "topic", repo: "lib" });
    expect(contentOf(inside)).toBe("topic src\n");
    const around = await client.workspace.file({ path: "README.md", branch: "topic", repo: "lib" });
    expect(contentOf(around)).toBe("main readme\n");
    expect(around.present && around.shared).toBe(true);
    // A repository nested inside the one viewed is its own: the workspace's branch does not hold it.
    expect(contentOf(await client.workspace.file({ path: "lib/src.ts", branch: "feature" }))).toBe("main src\n");
});

test("the tree is the shared one with the viewed repository's part walked on the branch", async () => {
    const work = workspaceWithBranches();
    const { client } = routesOver(work);
    const nested = await client.workspace.tree({ branch: "topic", repo: "lib" });
    const paths = pathsOf(nested.tree);
    expect(paths).toEqual(expect.arrayContaining(["README.md", "notes.md", "lib", "lib/src.ts"]));
    expect(paths).not.toContain("lib/old.ts");
    expect(nested.generation).toBeUndefined();
    const workspace = pathsOf((await client.workspace.tree({ branch: "feature" })).tree);
    expect(workspace).toEqual(expect.arrayContaining(["README.md", "feature-only.md", "lib"]));
    expect(workspace).not.toContain("notes.md");
    // A folder's listing is laid together the same way.
    const listed = await client.workspace.children({ path: "lib", branch: "topic", repo: "lib" });
    expect(listed.entries.map((entry) => entry.path)).toContain("lib/src.ts");
    expect(listed.entries.map((entry) => entry.path)).not.toContain("lib/old.ts");
});

test("raw bytes are read from the same copy as the text", async () => {
    const work = workspaceWithBranches();
    const { app } = routesOver(work);
    const response = await app.request("/workspace/raw?path=README.md&branch=feature", { headers: { authorization: "Bearer member" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("feature readme\n");
    const refused = await app.request("/workspace/raw?path=README.md&branch=main", { headers: { authorization: "Bearer member" } });
    expect(refused.status).toBe(400);
});

test("a branch only origin has is made locally at origin's tip, and reads", async () => {
    const work = workspaceWithBranches();
    const { client } = routesOver(work);
    expect(contentOf(await client.workspace.file({ path: "lib/remote.ts", branch: "remote-only", repo: "lib" }))).toBe("from origin\n");
    expect(git(join(work, "lib"), "rev-parse", "remote-only")).toBe(git(join(work, "lib"), "rev-parse", "origin/remote-only"));
    expect(git(join(work, "lib"), "symbolic-ref", "--short", "HEAD")).toBe("main");
});

test("what no view may name is refused before anything is checked out", async () => {
    const work = workspaceWithBranches();
    const { client } = routesOver(work);
    // The shared checkout's own line is the shared tree itself; an agent's branch is read through that agent.
    expect(await errorCode(client.workspace.file({ path: "README.md", branch: "main" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.workspace.file({ path: "README.md", branch: "agent/c1" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.workspace.tree({ branch: "feature", agent: "c1" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.workspace.file({ path: "README.md", repo: "lib" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.workspace.file({ path: "README.md", branch: "nowhere" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.file({ path: "x", branch: "topic", repo: "missing" }))).toBe("NOT_FOUND");
    expect(git(work, "worktree", "list").split("\n")).toHaveLength(1);
});

test("a fenced reader is fenced on a branch exactly as on the shared tree", async () => {
    const work = workspaceWithBranches();
    const { client, fence } = routesOver(work);
    fence();
    const shared = await errorCode(client.workspace.file({ path: "README.md" }));
    expect(shared).toBe("FORBIDDEN");
    expect(await errorCode(client.workspace.file({ path: "README.md", branch: "feature" }))).toBe(shared);
    expect(contentOf(await client.workspace.file({ path: "support/faq.md", branch: "feature" }))).toBe("how to refund\n");
    expect(pathsOf((await client.workspace.tree({ branch: "feature" })).tree)).toEqual(["support", "support/faq.md"]);
});
