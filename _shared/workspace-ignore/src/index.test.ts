import { expect, test } from "vitest";
import { createIgnoreScope, IGNORED_DIRS, isAgentWorktreePath, isBrowserProfilePath, isReferencePath, scannerPruneGlobs } from "./index.js";

test("the browser-login profile subtree (auth cookies) is treated as ignored, but the rest of .intentic isn't", () => {
    expect(isBrowserProfilePath(".intentic/local/browser/reddit/Default/Cookies")).toBe(true);
    expect(isBrowserProfilePath(".intentic/local/browser/x.connected")).toBe(true);
    expect(isBrowserProfilePath(".intentic/config/automations.json")).toBe(false);
    expect(isBrowserProfilePath(".intentic/config/environment.Dockerfile")).toBe(false);
});

// What the browsing produced, not the profile it ran under: written once, meant to be opened, linked from the chat's
// tool cards.
test("browser artifacts are ordinary files, not profile churn", () => {
    expect(isBrowserProfilePath(".intentic/records/artifacts/browser")).toBe(false);
    expect(isBrowserProfilePath(".intentic/records/artifacts/browser/page-2026-07-30T10-00-00.png")).toBe(false);
});

test("agent worktrees (.claude/worktrees: throwaway full checkouts) are treated as ignored, but the rest of .claude isn't", () => {
    expect(isAgentWorktreePath(".claude/worktrees")).toBe(true);
    expect(isAgentWorktreePath(".claude/worktrees/file-nesting/_platform/api/vitest.config.ts")).toBe(true);
    expect(isAgentWorktreePath("intentic/.claude/worktrees/file-nesting")).toBe(true);
    expect(isAgentWorktreePath(".claude/skills/review/SKILL.md")).toBe(false);
    expect(isAgentWorktreePath(".claude/settings.json")).toBe(false);
    // "worktrees" only counts directly under a .claude segment.
    expect(isAgentWorktreePath("repo/worktrees/main")).toBe(false);
});

test("the reference shelf is the ROOT-level refs/ only, a repo's own refs dir stays ordinary content", () => {
    expect(isReferencePath("refs")).toBe(true);
    expect(isReferencePath("refs/react/packages/scheduler/index.js")).toBe(true);
    expect(isReferencePath("myrepo/refs/notes.md")).toBe(false);
    expect(isReferencePath("refactor/src/main.ts")).toBe(false);
    expect(isReferencePath("")).toBe(false);
});

test("IgnoreScope.isIgnored grays junk dirs (incl. .git) + browser profiles; leaves tracked source & lone secrets alone", () => {
    const scope = createIgnoreScope();
    expect(scope.isIgnored("node_modules", "node_modules", true)).toBe(true);
    expect(scope.isIgnored(".pnpm-store", ".pnpm-store", true)).toBe(true);
    expect(scope.isIgnored("__pycache__", "app/__pycache__", true)).toBe(true);
    expect(scope.isIgnored(".tmp", ".intentic/secrets/auth/codex/.tmp", true)).toBe(true);
    // .git is a junk-ignored dir (grayed + lazy-loaded), not a security-floor secret.
    expect(scope.isIgnored(".git", "repo/.git", true)).toBe(true);
    // The browser-profile subtree is ignored regardless of the inner file names.
    expect(scope.isIgnored("browser", ".intentic/local/browser", true)).toBe(true);
    expect(scope.isIgnored("Cookies", ".intentic/local/browser/reddit/Default/Cookies", false)).toBe(true);
    // The reference shelf is ignored as a subtree; a repo's own refs/ dir is not the shelf.
    expect(scope.isIgnored("refs", "refs", true)).toBe(true);
    expect(scope.isIgnored("scheduler.js", "refs/react/packages/scheduler.js", false)).toBe(true);
    expect(scope.isIgnored("refs", "myrepo/refs", true)).toBe(false);
    // Agent worktrees are ignored as a subtree; sibling .claude config stays tracked.
    expect(scope.isIgnored("worktrees", "repo/.claude/worktrees", true)).toBe(true);
    expect(scope.isIgnored("land.ts", "repo/.claude/worktrees/fix/src/land.ts", false)).toBe(true);
    expect(scope.isIgnored("skills", "repo/.claude/skills", true)).toBe(false);
    // No security floor: a secret file is not ignored by name, it only grays if .gitignore'd.
    expect(scope.isIgnored(".env", "repo/.env", false)).toBe(false);
    // Ambiguous dirs are not on the denylist: left to .gitignore.
    expect(scope.isIgnored("build", "repo/build", true)).toBe(false);
    expect(scope.isIgnored("src", "repo/src", true)).toBe(false);
});

// Written as the claim itself, not a list of strings: every subtree isIgnored rejects must be prunable.
test("scannerPruneGlobs covers every subtree isIgnored rejects by rule", () => {
    const globs = scannerPruneGlobs(false);
    for (const dir of IGNORED_DIRS) {
        expect(globs).toContain(`!**/${dir}`);
    }
    // Root-anchored, matching isReferencePath; a bare `!refs` would prune a repo's own refs/ too.
    expect(globs).toContain("!/refs");
    expect(globs).not.toContain("!**/refs");
    expect(globs).toContain("!**/.claude/worktrees");
});

// `--ignored` lifts the attention boundaries together, as isIgnored does; `.git` never lifts, since it's history rather
// than source.
test("scannerPruneGlobs under includeIgnored keeps only .git", () => {
    expect(scannerPruneGlobs(true)).toEqual(["!**/.git"]);
});

// The agent plane is deliberately absent: it's the search engine's own default-deny floor, derived from the state
// table, not an attention boundary this package decides.
test("scannerPruneGlobs leaves the agent plane to the engine's floor", () => {
    expect(scannerPruneGlobs(false).some((glob) => glob.includes(".intentic"))).toBe(false);
});

// A git pointer file (worktree, submodule, --separate-git-dir) is deliberately not ignored here: a portability bundle
// has to carry it. Keeping it out of search is the sweep's own call.
test("a .git pointer file is left to each caller: this layer only knows the directory", () => {
    const scope = createIgnoreScope();
    expect(scope.isIgnored(".git", "repo/.git", true)).toBe(true);
    expect(scope.isIgnored(".git", "repo/.git", false)).toBe(false);
});
