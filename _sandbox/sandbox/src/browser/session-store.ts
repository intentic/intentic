import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { statePath } from "../workspace/state-paths.js";

// A logged-in browser session for one social platform. The session IS a persistent Chromium profile: the
// owner's own profile window (browser/browser-profile.ts) writes it, the agent's @playwright/mcp reads it via
// `--user-data-dir`, and both point Chromium at `sessionDir`. It lives under .intentic (outside the three repos,
// gitignored, never committed) on the /work volume, so it survives a sandbox rebuild like claude.json does.

// The Chromium `--user-data-dir` for a platform.
export const sessionDir = (root: string, platform: string): string => statePath(root, ".intentic/browser/", platform);

// A completed-login marker, kept OUTSIDE the profile dir so Chromium never rewrites it. A bare profile dir
// exists the moment Chromium launches (before any login), so its presence can't mean "connected" — the marker,
// written only when the owner finishes the guided login, is the real "connected" probe.
const markerPath = (root: string, platform: string): string => statePath(root, ".intentic/browser/", `${platform}.connected`);

// The platform's WebAuthn passkey store (passkeys.ts) — beside the profile because it is part of the same
// identity: the sandbox's own software security key for that site, exactly as sensitive as the profile's
// cookies and torn down with them.
export const passkeyPath = (root: string, platform: string): string => statePath(root, ".intentic/browser/", `${platform}.passkeys.json`);

export const hasSession = (root: string, platform: string): boolean => existsSync(markerPath(root, platform));

// Drop an empty marker beside the profile dir. Ensures the parent exists (it will after a real login, but this
// keeps the helper self-sufficient).
export const markConnected = async (root: string, platform: string): Promise<void> => {
    const path = markerPath(root, platform);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
};

export const clearSession = async (root: string, platform: string): Promise<void> => {
    await rm(sessionDir(root, platform), { recursive: true, force: true });
    await rm(markerPath(root, platform), { force: true });
    await rm(passkeyPath(root, platform), { force: true });
};

// A persistent `--user-data-dir` can't be opened twice: while the owner has a platform's profile open in their
// own window (signing in, or using the account by hand), the per-turn @playwright/mcp for that platform must
// not spawn (and vice-versa). One daemon process, so a module-level set is the whole lock — no cross-process
// concern.
const profileLocks = new Set<string>();

export const isProfileOpen = (platform: string): boolean => profileLocks.has(platform);

export const acquireProfileLock = (platform: string): boolean => {
    if (profileLocks.has(platform)) {
        return false;
    }
    profileLocks.add(platform);
    return true;
};

export const releaseProfileLock = (platform: string): void => {
    profileLocks.delete(platform);
};
