import { WORKSPACE_ROOT } from "@intentic/constants";
import { type ReferenceView, resolveReference } from "./resolve-reference.js";

const WORKSPACE = [
    "_editor/web/src/pages/workspace/WorkspaceDesktop.vue",
    "_editor/web/src/pages/sandbox/SandboxSync.vue",
    "docs/pages/index.md",
    "src/foo.ts",
];

const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const endsWithPath = (path: string, tail: string): boolean => path === tail || path.endsWith(`/${tail}`);

// One copy as the route presents it: existence, the two listings over the same files, and the copy's renames. `seen`
// records what was searched for, in order.
const viewOf = (files: readonly string[], renamed: ReadonlyMap<string, string> = new Map(), seen: string[] = []): ReferenceView => ({
    exists: (relPath) => files.includes(relPath),
    endingWith: async (tail) => {
        seen.push(`**/${tail}`);
        return files.filter((file) => endsWithPath(file, tail));
    },
    inFolder: async (folder) => {
        seen.push(`**/${folder}/*`);
        return files.filter((file) => endsWithPath(folderOf(file), folder));
    },
    renamed,
});

const resolve = (reference: string, files: readonly string[] = WORKSPACE, seen: string[] = []) =>
    resolveReference(reference, WORKSPACE_ROOT, viewOf(files, new Map(), seen));

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

test("takes the shallowest match when a reference is ambiguous, and names the others rather than hiding them", async () => {
    const files = ["b/c/pages/index.md", "a/pages/index.md"];
    expect(await resolve("pages/index.md", files)).toEqual({ path: "a/pages/index.md", others: ["b/c/pages/index.md"] });
});

test("stops at the first tail that matches: a longer tail is the more specific answer", async () => {
    const seen: string[] = [];
    await resolve("web/src/pages/sandbox/SandboxSync.vue", WORKSPACE, seen);
    expect(seen).toEqual(["**/web/src/pages/sandbox/SandboxSync.vue"]);
});

test("answers nothing for a path the workspace has no file for", async () => {
    expect(await resolve("/usr/lib/node/repl.js")).toEqual({});
});

test("finds a file the conversation created, written as the repo-relative path an agent uses", async () => {
    // The checkout holds a repo (`intentic/`) below the workspace root; the agent names files from inside it.
    const files = ["intentic/_os/os-image/README.md", "intentic/_os/os-image/installer/bib-config.toml"];
    expect(await resolve("_os/os-image/README.md", files)).toEqual({ path: "intentic/_os/os-image/README.md" });
});

describe("a file the conversation renamed", () => {
    const renamed = new Map([["intentic/_os/installer/config.toml", "intentic/_os/installer/bib-config.toml"]]);
    // The shared tree still holds the old name: the view says it exists, which is exactly the trap.
    const files = ["intentic/_os/installer/bib-config.toml", "intentic/_os/installer/config.toml"];

    test("opens the file where it went, even though the old name still exists in the shared tree", async () => {
        expect(await resolveReference("intentic/_os/installer/config.toml", WORKSPACE_ROOT, viewOf(files, renamed))).toEqual({
            path: "intentic/_os/installer/bib-config.toml",
            renamedFrom: "intentic/_os/installer/config.toml",
        });
    });

    test("follows it from the short form an agent writes too", async () => {
        const moved = ["intentic/_os/installer/bib-config.toml"];
        expect(await resolveReference("installer/config.toml", WORKSPACE_ROOT, viewOf(moved, renamed))).toEqual({
            path: "intentic/_os/installer/bib-config.toml",
            renamedFrom: "intentic/_os/installer/config.toml",
        });
    });
});

describe("a reference nothing matches", () => {
    test("offers the file renamed in place: the folder it named still holds a name containing the old one", async () => {
        // Created and renamed within one turn, so git has no rename to follow: only the folder's contents say it.
        const files = ["intentic/_os/os-image/installer/bib-config.toml", "intentic/_os/os-image/installer/ks.cfg", "intentic/_os/os-image/disk.sh"];
        expect(await resolve("installer/config.toml", files)).toEqual({ nearby: ["intentic/_os/os-image/installer/bib-config.toml"] });
    });

    test("offers the same name elsewhere, closest to where it was first", async () => {
        const files = ["a/b/zz/config.toml", "far/away/config.toml", "intentic/_os/os-image/x/config.toml"];
        const { nearby } = await resolve("_os/os-image/installer/config.toml", files);
        expect(nearby?.[0]).toBe("intentic/_os/os-image/x/config.toml");
        expect(nearby).toHaveLength(3);
    });

    test("leaves out names merely sharing an extension, and stems too short to mean anything", async () => {
        const files = ["installer/other.toml", "installer/co.toml", "installer/config.json"];
        expect(await resolve("installer/config.toml", files)).toEqual({});
    });

    test("tries the most specific form of the folder that still exists, not every folder of that name", async () => {
        const seen: string[] = [];
        const files = ["intentic/_os/os-image/installer/bib-config.toml", "elsewhere/installer/my-config.toml"];
        const { nearby } = await resolve("os-image/installer/config.toml", files, seen);
        expect(nearby).toEqual(["intentic/_os/os-image/installer/bib-config.toml"]);
        expect(seen).toContain("**/os-image/installer/*");
        expect(seen).not.toContain("**/installer/*");
    });
});
