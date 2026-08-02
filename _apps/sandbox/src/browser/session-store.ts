import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserPlatform } from "@intentic/sandbox-contract";
import { statePath } from "../workspace/state-paths.js";

// A logged-in browser session for one social platform. The session IS a persistent Chromium profile: the
// guided-login flow (system/browser-login.ts) writes it, the agent's @playwright/mcp reads it via
// `--user-data-dir`, and both point Chromium at `sessionDir`. It lives under .intentic (outside the three repos,
// gitignored, never committed) on the /work volume, so it survives a sandbox rebuild like claude.json does.

// The Chromium `--user-data-dir` for a platform.
export const sessionDir = (root: string, platform: BrowserPlatform): string => statePath(root, ".intentic/browser/", platform);

// A completed-login marker, kept OUTSIDE the profile dir so Chromium never rewrites it. A bare profile dir
// exists the moment Chromium launches (before any login), so its presence can't mean "connected" — the marker,
// written only when the owner finishes the guided login, is the real "connected" probe.
const markerPath = (root: string, platform: BrowserPlatform): string => statePath(root, ".intentic/browser/", `${platform}.connected`);

export const hasSession = (root: string, platform: BrowserPlatform): boolean => existsSync(markerPath(root, platform));

// Drop an empty marker beside the profile dir. Ensures the parent exists (it will after a real login, but this
// keeps the helper self-sufficient).
export const markConnected = async (root: string, platform: BrowserPlatform): Promise<void> => {
    const path = markerPath(root, platform);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
};

export const clearSession = async (root: string, platform: BrowserPlatform): Promise<void> => {
    await rm(sessionDir(root, platform), { recursive: true, force: true });
    await rm(markerPath(root, platform), { force: true });
};

// A persistent `--user-data-dir` can't be opened twice: while a guided login holds a platform's profile, the
// per-turn @playwright/mcp for that platform must not spawn (and vice-versa). One daemon process, so a
// module-level set is the whole lock — no cross-process concern.
const loginLocks = new Set<BrowserPlatform>();

export const isLoginActive = (platform: BrowserPlatform): boolean => loginLocks.has(platform);

export const acquireLoginLock = (platform: BrowserPlatform): boolean => {
    if (loginLocks.has(platform)) {
        return false;
    }
    loginLocks.add(platform);
    return true;
};

export const releaseLoginLock = (platform: BrowserPlatform): void => {
    loginLocks.delete(platform);
};
