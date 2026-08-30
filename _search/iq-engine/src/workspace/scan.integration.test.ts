import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeFixtureWorkspace } from "../testing.js";
import { filterScope, langOf, sweep } from "./scan.js";
import type { FileEntry } from "../types.js";

let root: string;
let cleanup: () => Promise<void>;
let entries: FileEntry[];

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
    entries = await sweep(root, false);
});
afterAll(() => cleanup());

const paths = (): string[] => entries.map((entry) => entry.path);

test("sweep admits tracked-looking files and is path-sorted", () => {
    expect(paths()).toContain("alpha/src/widget.ts");
    expect(paths()).toContain("beta/app.py");
    expect(paths()).toContain("notes.md");
    expect(paths()).toEqual(paths().toSorted());
});

test("sweep enforces .gitignore + junk dirs (incl. .git) by default and always self-excludes the index dir", async () => {
    expect(paths()).not.toContain("alpha/dist/decoy.js"); // .gitignore layer
    expect(paths().some((path) => path.includes(".git/"))).toBe(false); // .git is a junk-ignored dir
    // No security floor: a non-gitignore'd secret is indexed like any other file (role-based gating comes later).
    expect(paths()).toContain(".env");
    expect(paths()).toContain(".env.example");
    expect(paths().some((path) => path.startsWith(".intentic/local/cache/iq"))).toBe(false); // index self-exclusion

    const full = await sweep(root, true);
    const fullPaths = full.map((entry) => entry.path);
    expect(fullPaths).toContain("alpha/dist/decoy.js"); // --ignored lifts .gitignore + junk dirs…
    expect(fullPaths.some((path) => path.includes(".git/"))).toBe(true); // …including .git now
    expect(fullPaths.some((path) => path.startsWith(".intentic/local/cache/iq"))).toBe(false); // …but never the index dir
});

test("the reference shelf is skipped by default and reachable via --ignored, like the junk layer", async () => {
    await mkdir(join(root, "refs/react/src"), { recursive: true });
    await writeFile(join(root, "refs/react/src/scheduler.ts"), "export const schedule = 1;\n");
    const swept = (await sweep(root, false)).map((entry) => entry.path);
    // Consultation material must not outrank (or even sit beside) the workspace's own code in default search.
    expect(swept).not.toContain("refs/react/src/scheduler.ts");
    // …but it is an attention boundary, not a floor: --ignored (and explicit path scoping with it) reaches it.
    const full = (await sweep(root, true)).map((entry) => entry.path);
    expect(full).toContain("refs/react/src/scheduler.ts");
});

// Every repo in this workspace is a worktree whose real gitdir lives outside it, so `.git` is a POINTER FILE,
// not a directory. It still has to sweep as git metadata: as content it leaks a host path from outside the
// workspace, and its byte count changes whenever the worktree is re-pointed, which left the index permanently
// reporting files behind that no pass could ever reconcile.
test("a .git worktree pointer file is junk like a .git dir, and still liftable with --ignored", async () => {
    await mkdir(join(root, "gamma/src"), { recursive: true });
    await writeFile(join(root, "gamma/src/main.ts"), "export const main = 1;\n");
    await writeFile(join(root, "gamma/.git"), "gitdir: /elsewhere/gits/gamma\n");
    const swept = await sweep(root, false);
    expect(swept.map((entry) => entry.path)).not.toContain("gamma/.git");
    expect(swept.map((entry) => entry.path)).toContain("gamma/src/main.ts"); // the repo around it stays searchable
    // Ignoring the pointer must not un-name the repo it marks: churn, hotspots, recent, log and who all key off
    // this, and they go silently blank for a repo whose entries carry no `repo`.
    expect(swept.find((entry) => entry.path === "gamma/src/main.ts")?.repo).toBe("gamma");

    const full = (await sweep(root, true)).map((entry) => entry.path);
    expect(full).toContain("gamma/.git"); // junk, not floor — the same escape hatch a .git dir has
});

test("the agent plane's byproducts are excluded, its manifests are not", async () => {
    // The state dir is grouped, so the config folder has to exist before a manifest can be written into it:
    // the fixture only makes the cache tree.
    await mkdir(join(root, `${STATE_DIR}/config`), { recursive: true });
    await writeFile(join(root, `${STATE_DIR}/config/settings.json`), '{ "theme": "dark" }\n');
    const excluded = [
        `${STATE_DIR}/secrets/auth/codex/default/auth.json`,
        `${STATE_DIR}/records/sessions/claude/projects/session.jsonl`,
        `${STATE_DIR}/records/artifacts/attachments/u1/brief.md`,
        `${STATE_DIR}/local/runtime/extensions/whatsapp/gateway.url`,
        `${STATE_DIR}/local/browser/reddit/Default/Cookies`,
        // A tree the state table has never heard of. The floor is an allow-list, so tomorrow's undeclared store
        // is out of scope by construction rather than by somebody remembering to name it.
        `${STATE_DIR}/some-future-store/state.bin`,
        // A workspace can contain checkouts that are themselves intentic workspaces: their byproducts are no
        // more searchable than the root's own.
        "alpha/.intentic/local/cache/iq/index.db",
    ];
    await Promise.all(
        excluded.map(async (path) => {
            await mkdir(dirname(join(root, path)), { recursive: true });
            await writeFile(join(root, path), "private state\n");
        }),
    );
    const swept = (await sweep(root, false)).map((entry) => entry.path);
    for (const path of excluded) {
        expect(swept).not.toContain(path);
    }
    // Manifests are user-authored config an agent is routinely asked to find and edit.
    expect(swept).toContain(".intentic/config/settings.json");
    // …and the floor holds with --ignored too, which lifts only the gitignore/junk layers.
    const full = (await sweep(root, true)).map((entry) => entry.path);
    for (const path of excluded) {
        expect(full).not.toContain(path);
    }
});

test("sweep tags files with their enclosing git repo", () => {
    const widget = entries.find((entry) => entry.path === "alpha/src/widget.ts");
    expect(widget?.repo).toBe("alpha");
    const notes = entries.find((entry) => entry.path === "notes.md");
    expect(notes?.repo).toBeUndefined();
});

test("filterScope narrows by path, lang, glob, and file class", () => {
    expect(filterScope(entries, { paths: ["beta"] }).map((entry) => entry.path)).toEqual(["beta/app.py"]);
    expect(filterScope(entries, { langs: ["python"] }).map((entry) => entry.path)).toEqual(["beta/app.py"]);
    expect(filterScope(entries, { globs: ["**/*.ts"] }).every((entry) => entry.path.endsWith(".ts"))).toBe(true);
    expect(filterScope(entries, { notGlobs: ["**/*.ts"] }).some((entry) => entry.path.endsWith(".ts"))).toBe(false);
    expect(filterScope(entries, { only: "tests" }).map((entry) => entry.path)).toEqual(["alpha/src/widget.spec.ts"]);
    expect(filterScope(entries, { repo: "alpha" }).every((entry) => entry.path.startsWith("alpha/"))).toBe(true);
});

// A worktree, a submodule, and any --separate-git-dir repo (how the daemon versions the workspace root) carry a
// `.git` POINTER FILE instead of a directory. Missing that left their files unattributed, and every git-backed
// verb reads `repo`: churn, hotspots, recent, log, who.
test("a .git pointer file bounds a repo exactly like a .git directory", async () => {
    await writeFile(join(root, "beta/.git"), "gitdir: /elsewhere/beta.git\n");
    const swept = await sweep(root, false);
    expect(swept.find((entry) => entry.path === "beta/app.py")?.repo).toBe("beta");
    // Nested boundaries still win over the enclosing one, and unrepo'd files stay unattributed.
    expect(swept.find((entry) => entry.path === "alpha/src/widget.ts")?.repo).toBe("alpha");
    expect(swept.find((entry) => entry.path === "notes.md")?.repo).toBeUndefined();
});

test("langOf maps extensions", () => {
    expect(langOf("a/b.ts")).toBe("ts");
    expect(langOf("a/b.py")).toBe("python");
    expect(langOf("a/b.unknown")).toBeUndefined();
});
