import { expect, test } from "vitest";
import { createIgnoreScope, isAgentWorktreePath, isBrowserProfilePath } from "./index.js";

test("the browser-login profile subtree (auth cookies) is treated as ignored, but the rest of .intentic isn't", () => {
    expect(isBrowserProfilePath(".intentic/browser/reddit/Default/Cookies")).toBe(true);
    expect(isBrowserProfilePath(".intentic/browser/x.connected")).toBe(true);
    expect(isBrowserProfilePath(".intentic/automations.json")).toBe(false);
    expect(isBrowserProfilePath(".intentic/environment.Dockerfile")).toBe(false);
});

test("agent worktrees (.claude/worktrees — throwaway full checkouts) are treated as ignored, but the rest of .claude isn't", () => {
    expect(isAgentWorktreePath(".claude/worktrees")).toBe(true);
    expect(isAgentWorktreePath(".claude/worktrees/file-nesting/_apps/api/vitest.config.ts")).toBe(true);
    expect(isAgentWorktreePath("intentic/.claude/worktrees/file-nesting")).toBe(true);
    expect(isAgentWorktreePath(".claude/skills/review/SKILL.md")).toBe(false);
    expect(isAgentWorktreePath(".claude/settings.json")).toBe(false);
    // "worktrees" only counts directly under a .claude segment.
    expect(isAgentWorktreePath("repo/worktrees/main")).toBe(false);
});

test("IgnoreScope.isIgnored grays junk dirs (incl. .git) + browser profiles; leaves tracked source & lone secrets alone", () => {
    const scope = createIgnoreScope();
    // Junk denylist.
    expect(scope.isIgnored("node_modules", "node_modules", true)).toBe(true);
    expect(scope.isIgnored(".pnpm-store", ".pnpm-store", true)).toBe(true);
    expect(scope.isIgnored("__pycache__", "app/__pycache__", true)).toBe(true);
    expect(scope.isIgnored(".tmp", ".intentic/codex/.tmp", true)).toBe(true);
    // `.git` is now a junk-ignored dir (grayed + lazy-loaded), not a security-floor secret.
    expect(scope.isIgnored(".git", "repo/.git", true)).toBe(true);
    // The browser-profile subtree is ignored (grayed + lazy) regardless of the inner file names.
    expect(scope.isIgnored("browser", ".intentic/browser", true)).toBe(true);
    expect(scope.isIgnored("Cookies", ".intentic/browser/reddit/Default/Cookies", false)).toBe(true);
    // Agent worktrees are ignored as a subtree; sibling .claude config stays tracked.
    expect(scope.isIgnored("worktrees", "repo/.claude/worktrees", true)).toBe(true);
    expect(scope.isIgnored("land.ts", "repo/.claude/worktrees/fix/src/land.ts", false)).toBe(true);
    expect(scope.isIgnored("skills", "repo/.claude/skills", true)).toBe(false);
    // No security floor: a secret file is NOT ignored by name — it only grays if .gitignore'd.
    expect(scope.isIgnored(".env", "repo/.env", false)).toBe(false);
    // Ambiguous dirs are NOT on the denylist — left to .gitignore.
    expect(scope.isIgnored("build", "repo/build", true)).toBe(false);
    expect(scope.isIgnored("src", "repo/src", true)).toBe(false);
});
