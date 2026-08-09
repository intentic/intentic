import { WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test } from "vitest";
import { resolveReference } from "./resolve-reference.js";

const WORKSPACE = [
    "_editor/web/src/pages/workspace/WorkspaceDesktop.vue",
    "_editor/web/src/pages/sandbox/SandboxSync.vue",
    "docs/pages/index.md",
    "src/foo.ts",
];

// The workspace as the route sees it: an existence check and a glob over the same file list.
const resolve = (reference: string, files: readonly string[] = WORKSPACE, seen: string[] = []) =>
    resolveReference(
        reference,
        WORKSPACE_ROOT,
        (relPath) => files.includes(relPath),
        async (glob) => {
            seen.push(glob);
            const tail = glob.slice(3);
            // The engine's glob is anchored at the string level only — the boundary check is the ranker's job.
            return files.filter((file) => file.endsWith(tail));
        },
    );

test("resolves the abbreviated path an agent writes once the area is established", async () => {
    expect(await resolve("pages/workspace/WorkspaceDesktop.vue")).toEqual({ path: "_editor/web/src/pages/workspace/WorkspaceDesktop.vue" });
});

test("takes a reference that already names a real file as-is, without searching", async () => {
    const seen: string[] = [];
    expect(await resolve("src/foo.ts", WORKSPACE, seen)).toEqual({ path: "src/foo.ts" });
    expect(seen).toEqual([]);
});

test("maps an isolated turn's worktree path onto the file it mirrors", async () => {
    expect((await resolve("/history/worktrees/agent-7/src/foo.ts")).path).toBe("src/foo.ts");
});

test("takes the shallowest match when a reference is ambiguous", async () => {
    const files = ["b/c/pages/index.md", "a/pages/index.md"];
    expect(await resolve("pages/index.md", files)).toEqual({ path: "a/pages/index.md" });
});

test("stops at the first tail that matches — a longer tail is the more specific answer", async () => {
    const seen: string[] = [];
    await resolve("web/src/pages/sandbox/SandboxSync.vue", WORKSPACE, seen);
    expect(seen).toEqual(["**/web/src/pages/sandbox/SandboxSync.vue"]);
});

test("answers nothing for a path the workspace has no file for", async () => {
    expect(await resolve("/usr/lib/node/repl.js")).toEqual({});
});
