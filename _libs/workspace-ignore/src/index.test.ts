import { expect, test } from "vitest";
import { createIgnoreScope, isBrowserProfilePath } from "./index.js";

test("the browser-login profile subtree (auth cookies) is treated as ignored, but the rest of .intentic isn't", () => {
    expect(isBrowserProfilePath(".intentic/browser/reddit/Default/Cookies")).toBe(true);
    expect(isBrowserProfilePath(".intentic/browser/x.connected")).toBe(true);
    expect(isBrowserProfilePath(".intentic/automations.json")).toBe(false);
    expect(isBrowserProfilePath(".intentic/environment.Dockerfile")).toBe(false);
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
    // No security floor: a secret file is NOT ignored by name — it only grays if .gitignore'd.
    expect(scope.isIgnored(".env", "repo/.env", false)).toBe(false);
    // Ambiguous dirs are NOT on the denylist — left to .gitignore.
    expect(scope.isIgnored("build", "repo/build", true)).toBe(false);
    expect(scope.isIgnored("src", "repo/src", true)).toBe(false);
});
