import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { listWorkspaceChildren, walkWorkspaceTree } from "./workspace-tree.js";

// Flatten the nested tree to a set of paths for easy assertions.
const paths = (entries: readonly WorkspaceTreeEntry[]): string[] =>
    entries.flatMap((entry) => [entry.path, ...(entry.children ? paths(entry.children) : [])]);

test("walkWorkspaceTree lists everything, graying ignored dirs (node_modules, .git) without descending into them", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-tree-"));
    await mkdir(join(root, "app", "src"), { recursive: true });
    await mkdir(join(root, "app", "node_modules", "dep"), { recursive: true });
    await mkdir(join(root, "app", ".git"), { recursive: true });
    await mkdir(join(root, `${STATE_DIR}`), { recursive: true });
    await mkdir(join(root, "desired-state"), { recursive: true });
    await writeFile(join(root, "app", "src", "index.ts"), "console.log(1);");
    await writeFile(join(root, "app", "untracked.tmp"), "scratch"); // untracked — should still show
    await writeFile(join(root, "app", "node_modules", "dep", "index.js"), "module.exports={}");
    await writeFile(join(root, "app", ".git", "config"), "[core]");
    await writeFile(join(root, `${STATE_DIR}`, "claude.json"), '{"accessToken":"secret"}');
    await writeFile(join(root, "desired-state", ".env"), "SECRET=1");
    await writeFile(join(root, "desired-state", ".env.example"), "SECRET=");

    const result = await walkWorkspaceTree(root);
    const all = paths(result.tree);

    expect(result.hidden).toBe(0);
    // Tracked + untracked source shows as normal entries.
    expect(all).toContain("app/src/index.ts");
    expect(all).toContain("app/untracked.tmp");
    expect(all).toContain("desired-state/.env.example");
    // Nothing is hidden anymore — former security-floor files list too.
    expect(all).toContain(".intentic/claude.json");
    expect(all).toContain("desired-state/.env");
    // Ignored dirs are listed (grayed) but NOT descended — their children lazy-load via listWorkspaceChildren.
    expect(all).toContain("app/node_modules");
    expect(all).toContain("app/.git");
    expect(all).not.toContain("app/node_modules/dep");
    expect(all).not.toContain("app/node_modules/dep/index.js");
    expect(all).not.toContain("app/.git/config");
    // …and they carry the `ignored` flag so the client grays them; tracked source does not.
    const app = result.tree.find((entry) => entry.name === "app");
    expect(app?.children?.find((entry) => entry.name === "node_modules")?.ignored).toBe(true);
    expect(app?.children?.find((entry) => entry.name === ".git")?.ignored).toBe(true);
    expect(app?.children?.find((entry) => entry.name === "src")?.ignored).toBeUndefined();
});

test("walkWorkspaceTree grays .gitignore'd + junk paths (never descending), and lists former-secret files ungrayed", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-tree-ignore-"));
    await mkdir(join(root, "repo", "src"), { recursive: true });
    await mkdir(join(root, "repo", "out"), { recursive: true });
    await mkdir(join(root, ".pnpm-store", "v3"), { recursive: true });
    await mkdir(join(root, "repo", ".git"), { recursive: true });
    await writeFile(join(root, "repo", ".gitignore"), "out/\n*.log\n");
    await writeFile(join(root, "repo", "src", "app.ts"), "ok");
    await writeFile(join(root, "repo", "out", "bundle.js"), "gen");
    await writeFile(join(root, "repo", "debug.log"), "noise");
    await writeFile(join(root, ".pnpm-store", "v3", "index.js"), "store");
    await writeFile(join(root, "repo", ".git", "config"), "[core]");
    await writeFile(join(root, "repo", ".env"), "SECRET=1");

    const result = await walkWorkspaceTree(root);
    const all = paths(result.tree);

    expect(all).toContain("repo/src/app.ts");
    // Ignored entries are listed (grayed) but their subtrees are not walked.
    expect(all).toContain("repo/out");
    expect(all).not.toContain("repo/out/bundle.js");
    expect(all).toContain("repo/debug.log");
    expect(all).toContain(".pnpm-store");
    expect(all).not.toContain(".pnpm-store/v3/index.js");
    expect(all).toContain("repo/.git");
    expect(all).not.toContain("repo/.git/config");
    // A former-secret file that isn't .gitignore'd shows as a normal (ungrayed) entry.
    expect(all).toContain("repo/.env");

    const repo = result.tree.find((entry) => entry.name === "repo");
    const child = (name: string): WorkspaceTreeEntry | undefined => repo?.children?.find((entry) => entry.name === name);
    expect(child("out")?.ignored).toBe(true);
    expect(child("debug.log")?.ignored).toBe(true);
    expect(child(".git")?.ignored).toBe(true);
    expect(child(".env")?.ignored).toBeUndefined();
    expect(child("src")?.ignored).toBeUndefined();
    expect(result.tree.find((entry) => entry.name === ".pnpm-store")?.ignored).toBe(true);
});

test("walkWorkspaceTree grays agent worktrees (.claude/worktrees) without descending; sibling .claude config walks normally", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-tree-worktrees-"));
    await mkdir(join(root, "repo", ".claude", "worktrees", "fix", "_apps", "api"), { recursive: true });
    await mkdir(join(root, "repo", ".claude", "skills"), { recursive: true });
    await writeFile(join(root, "repo", ".claude", "worktrees", "fix", "_apps", "api", "vitest.config.ts"), "export default {};");
    await writeFile(join(root, "repo", ".claude", "skills", "SKILL.md"), "# skill");

    const result = await walkWorkspaceTree(root);
    const all = paths(result.tree);

    expect(all).toContain("repo/.claude/worktrees");
    expect(all).not.toContain("repo/.claude/worktrees/fix");
    expect(all).not.toContain("repo/.claude/worktrees/fix/_platform/api/vitest.config.ts");
    expect(all).toContain("repo/.claude/skills/SKILL.md");

    const claude = result.tree.find((entry) => entry.name === "repo")?.children?.find((entry) => entry.name === ".claude");
    expect(claude?.ignored).toBeUndefined();
    expect(claude?.children?.find((entry) => entry.name === "worktrees")?.ignored).toBe(true);
    expect(claude?.children?.find((entry) => entry.name === "skills")?.ignored).toBeUndefined();
});

test("listWorkspaceChildren lazily lists one level under an ignored dir, all grayed, dirs left un-descended", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-children-"));
    await mkdir(join(root, "node_modules", "dep", "nested"), { recursive: true });
    await writeFile(join(root, "node_modules", "dep", "index.js"), "x");
    await writeFile(join(root, "node_modules", "top.js"), "y");

    const { entries, hidden } = await listWorkspaceChildren(root, "node_modules");
    expect(hidden).toBe(0);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    // One level only: `dep` (dir) and `top.js` (file), both grayed; dep's own children are NOT included.
    expect(byName.get("dep")?.type).toBe("dir");
    expect(byName.get("dep")?.ignored).toBe(true);
    expect(byName.get("dep")?.children).toBeUndefined();
    expect(byName.get("top.js")?.type).toBe("file");
    expect(byName.get("top.js")?.ignored).toBe(true);
    expect(entries.some((entry) => entry.name === "index.js")).toBe(false);
    // A path climbing out of /work yields nothing.
    expect((await listWorkspaceChildren(root, "../etc")).entries).toEqual([]);
});

test("listWorkspaceChildren counts what its own cap cut — the only listing that can be incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-children-cap-"));
    await mkdir(join(root, "huge"), { recursive: true });
    for (let i = 0; i < 5; i++) {
        await writeFile(join(root, "huge", `file-${i}.txt`), "x");
    }
    const { entries, hidden } = await listWorkspaceChildren(root, "huge", { maxEntries: 2 });
    expect(entries.length).toBe(2);
    expect(hidden).toBe(3);
});

test("walkWorkspaceTree counts exactly how many of the ROOT's own entries the budget cut (the one unavoidable cut)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-tree-cap-"));
    for (let i = 0; i < 5; i++) {
        await writeFile(join(root, `file-${i}.txt`), "x");
    }
    const result = await walkWorkspaceTree(root, { maxEntries: 2 });
    expect(result.hidden).toBe(3);
    expect(paths(result.tree).length).toBe(2);
});

test("walkWorkspaceTree defers a dir that doesn't fit the remaining budget whole, rather than half-listing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-tree-dircap-"));
    await mkdir(join(root, "a"), { recursive: true });
    for (let i = 0; i < 5; i++) {
        await writeFile(join(root, "a", `file-${i}.txt`), "x");
    }
    // The root level (just "a") lists first, leaving 2 of the budget — not enough for "a"'s own 5 files.
    const result = await walkWorkspaceTree(root, { maxEntries: 3 });
    expect(result.hidden).toBe(0);
    const dirA = result.tree.find((e) => e.name === "a");
    // Unlisted, so expanding it lazy-loads all 5 — no partial listing, no "some items are missing" claim.
    expect(dirA?.children).toBeUndefined();
    expect((await listWorkspaceChildren(root, "a")).entries.length).toBe(5);
});

test("walkWorkspaceTree spends its budget breadth-first: shallow siblings survive a huge deep branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-tree-breadth-"));
    await mkdir(join(root, "aaa", "deep"), { recursive: true });
    await mkdir(join(root, "zzz"), { recursive: true });
    for (let i = 0; i < 20; i++) {
        await writeFile(join(root, "aaa", `file-${i}.txt`), "x");
    }
    await writeFile(join(root, "zzz", "kept.txt"), "x");

    // Depth-first, "aaa" would eat the whole budget and "zzz" would never be listed at all.
    const result = await walkWorkspaceTree(root, { maxEntries: 6 });
    expect(result.hidden).toBe(0);
    expect(result.tree.map((entry) => entry.name)).toEqual(["aaa", "zzz"]);
    // "aaa" doesn't fit what's left, so it defers whole; the budget goes to its sibling instead of vanishing.
    expect(result.tree.find((entry) => entry.name === "aaa")?.children).toBeUndefined();
    expect(result.tree.find((entry) => entry.name === "zzz")?.children?.map((entry) => entry.name)).toEqual(["kept.txt"]);
});

test("walkWorkspaceTree leaves a dir it never reached UNLISTED (no children) instead of claiming items are hidden", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-tree-unlisted-"));
    await mkdir(join(root, "a", "inner"), { recursive: true });
    await mkdir(join(root, "b"), { recursive: true });
    await writeFile(join(root, "b", "kept.txt"), "x");

    // Budget: "a" + "b" (level 1), then "a/inner" (level 2) — "b" is queued but never listed.
    const result = await walkWorkspaceTree(root, { maxEntries: 3 });
    const dirA = result.tree.find((entry) => entry.name === "a");
    const dirB = result.tree.find((entry) => entry.name === "b");
    expect(dirA?.children?.map((entry) => entry.name)).toEqual(["inner"]);
    // Unlisted, NOT truncated: no phantom "more items" claim — the client lazy-loads it on expand. The count
    // is on the ENVELOPE, so a claim of hidden entries would show up there; both root entries were listed.
    expect(dirB?.children).toBeUndefined();
    expect(result.hidden).toBe(0);
    expect((await listWorkspaceChildren(root, "b")).entries.map((entry) => entry.name)).toEqual(["kept.txt"]);
});

test("listWorkspaceChildren grades ignore state for a NON-ignored dir the budget never reached", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-children-normal-"));
    await mkdir(join(root, "repo", "src"), { recursive: true });
    await mkdir(join(root, "repo", "out"), { recursive: true });
    await mkdir(join(root, "repo", "node_modules"), { recursive: true });
    await writeFile(join(root, "repo", ".gitignore"), "out/\n");
    await writeFile(join(root, "repo", "app.ts"), "ok");
    await writeFile(join(root, "repo", "out", "bundle.js"), "gen");

    const { entries, hidden } = await listWorkspaceChildren(root, "repo");
    expect(hidden).toBe(0);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    // A lazily-listed normal dir is NOT blanket-grayed — only what the ignore rules actually cover.
    expect(byName.get("src")?.ignored).toBeUndefined();
    expect(byName.get("app.ts")?.ignored).toBeUndefined();
    expect(byName.get("out")?.ignored).toBe(true);
    expect(byName.get("node_modules")?.ignored).toBe(true);
    // …while everything under an ignored ancestor stays grayed.
    const nested = await listWorkspaceChildren(root, "repo/out");
    expect(nested.entries.every((entry) => entry.ignored === true)).toBe(true);
});

test("walkWorkspaceTree walks arbitrarily deep (no depth cap)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-tree-deep-"));
    const segments = Array.from({ length: 20 }, (_, i) => `d${i}`);
    await mkdir(join(root, ...segments), { recursive: true });
    await writeFile(join(root, ...segments, "deep.txt"), "x");
    const result = await walkWorkspaceTree(root);
    expect(result.hidden).toBe(0);
    expect(paths(result.tree)).toContain(`${segments.join("/")}/deep.txt`);
});

test("walkWorkspaceTree lists the daemon's own state entries but never lists what is inside them", async () => {
    // The file API refuses every path under these (isControlPlanePath), so the explorer draws one locked row
    // for each and stops. Listing their contents would spend the walk's entry budget — a Chromium profile is
    // thousands of files — on rows that can only ever answer "kept private".
    const root = await mkdtemp(join(tmpdir(), "ws-tree-locked-"));
    await mkdir(join(root, `${STATE_DIR}`, "browser", "Default"), { recursive: true });
    await mkdir(join(root, `${STATE_DIR}`, "auth", "codex"), { recursive: true });
    await mkdir(join(root, `${STATE_DIR}`, "drafts"), { recursive: true });
    await writeFile(join(root, `${STATE_DIR}`, "capabilities.json"), '{"entries":[]}');
    await writeFile(join(root, `${STATE_DIR}`, "settings.json"), "{}");
    await writeFile(join(root, `${STATE_DIR}`, "browser", "Default", "Cookies"), "sqlite");
    await writeFile(join(root, `${STATE_DIR}`, "auth", "codex", "auth.json"), '{"token":"secret"}');
    await writeFile(join(root, `${STATE_DIR}`, "drafts", "post-1.json"), "{}");

    const result = await walkWorkspaceTree(root);
    const all = paths(result.tree);

    // The locked entries are LISTED — they exist, and a tree that quietly dropped them would read as files
    // having gone missing.
    expect(all).toContain(".intentic/capabilities.json");
    expect(all).toContain(".intentic/browser");
    expect(all).toContain(".intentic/auth");
    // …with nothing of theirs behind them, on the eager walk or on a later ask.
    expect(all).not.toContain(".intentic/browser/Default");
    expect(all).not.toContain(".intentic/auth/codex");
    expect(await listWorkspaceChildren(root, `${STATE_DIR}/auth`)).toEqual({ entries: [], hidden: 0 });
    // The state dir's ORDINARY contents are untouched by any of this.
    expect(all).toContain(".intentic/settings.json");
    expect(all).toContain(".intentic/drafts/post-1.json");
});

/* SYMLINKS. They were filtered out of every listing, which is how `.claude/skills` — a folder holding thirty
 * links to the skills the sandbox loaded and nothing else — came to draw as an empty folder in the explorer. */

test("walkWorkspaceTree lists a symlink as what it points AT, carrying the link's own text", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-tree-link-"));
    await mkdir(join(root, "real", "nested"), { recursive: true });
    await writeFile(join(root, "real", "a.ts"), "export const a = 1;");
    await writeFile(join(root, "real", "nested", "b.ts"), "export const b = 2;");
    await mkdir(join(root, "links"), { recursive: true });
    await symlink("../real", join(root, "links", "to-dir"));
    await symlink("../real/a.ts", join(root, "links", "to-file"));

    const result = await walkWorkspaceTree(root);
    const links = result.tree.find((entry) => entry.name === "links")?.children ?? [];
    const dirLink = links.find((entry) => entry.name === "to-dir");
    const fileLink = links.find((entry) => entry.name === "to-file");

    // The TARGET's kind, so everything downstream — expanding, opening, the icon — needs no new branch.
    expect(dirLink?.type).toBe("dir");
    expect(fileLink?.type).toBe("file");
    // The link's own text, not the resolved path: it is what whoever made the link wrote.
    expect(dirLink?.link).toEqual({ to: "../real" });
    expect(fileLink?.link).toEqual({ to: "../real/a.ts" });
    // A linked directory is walked through, and its children are addressed through the LINK — the same file is
    // reachable by both paths and both open, exactly as VSCode's explorer does it.
    expect(paths(result.tree)).toContain("links/to-dir/nested/b.ts");
    expect(paths(result.tree)).toContain("real/nested/b.ts");
    // Dirs still sort first, and a link to a dir sorts as the dir it is.
    expect(links.map((entry) => entry.name)).toEqual(["to-dir", "to-file"]);
    // A plain entry carries no `link` at all.
    expect(result.tree.find((entry) => entry.name === "real")?.link).toBeUndefined();
});

test("walkWorkspaceTree lists a dangling symlink rather than hiding it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-tree-dangling-"));
    await symlink("./gone", join(root, "broken"));

    const entry = (await walkWorkspaceTree(root)).tree.find((candidate) => candidate.name === "broken");

    // Listed — a link that goes nowhere is a fact about the workspace, and one worth seeing.
    expect(entry?.link).toEqual({ to: "./gone", state: "broken" });
    // Nothing to expand into, so it reports as a file and the client draws no chevron.
    expect(entry?.type).toBe("file");
});

test("walkWorkspaceTree marks a symlink that leaves the workspace and never follows it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-tree-escape-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "ws-tree-elsewhere-"));
    await writeFile(join(elsewhere, "token.json"), '{"token":"secret"}');
    await symlink(elsewhere, join(root, "escape"));

    const result = await walkWorkspaceTree(root);
    const entry = result.tree.find((candidate) => candidate.name === "escape");

    expect(entry?.link).toEqual({ to: elsewhere, state: "outside" });
    // Shown, so the row can explain itself — but the walk stops dead at it, and so does a later expand.
    expect(paths(result.tree)).not.toContain("escape/token.json");
    expect(await listWorkspaceChildren(root, "escape")).toEqual({ entries: [], hidden: 0 });
});

test("walkWorkspaceTree does not loop on a symlink pointing back at an ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-tree-cycle-"));
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "b", "leaf.txt"), "x");
    await symlink("../..", join(root, "a", "b", "up")); // a/b/up -> root/a … and round again

    const result = await walkWorkspaceTree(root);
    const all = paths(result.tree);

    expect(all).toContain("a/b/leaf.txt");
    expect(all).toContain("a/b/up");
    // The link is listed and left unlisted-into: descending it would walk a/b/up/b/up/b… forever, and the
    // entry budget would be spent on one branch of nonsense.
    expect(all).not.toContain("a/b/up/b");
    expect(result.hidden).toBe(0);
});

test("listWorkspaceChildren follows symlinks the same way the eager walk does", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-children-link-"));
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true }); // ignored ⇒ lazy-loaded
    await mkdir(join(root, "real"), { recursive: true });
    await writeFile(join(root, "real", "a.ts"), "export const a = 1;");
    await symlink("../real", join(root, "node_modules", "linked"));
    await symlink("../nowhere", join(root, "node_modules", "dead"));

    const { entries } = await listWorkspaceChildren(root, "node_modules");
    const linked = entries.find((entry) => entry.name === "linked");

    expect(linked?.type).toBe("dir");
    expect(linked?.link).toEqual({ to: "../real" });
    expect(entries.find((entry) => entry.name === "dead")?.link).toEqual({ to: "../nowhere", state: "broken" });
    // …and expanding the link lists the target's contents, under the link's path.
    expect((await listWorkspaceChildren(root, "node_modules/linked")).entries.map((entry) => entry.path)).toEqual(["node_modules/linked/a.ts"]);
});
