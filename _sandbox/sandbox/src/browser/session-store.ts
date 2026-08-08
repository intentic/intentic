import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { statePath } from "../workspace/state-paths.js";

/* A logged-in browser session for ONE ACCOUNT. The session IS a persistent Chromium profile: the owner's own
 * profile window (browser/browser-profile.ts) writes it, the agent's @playwright/mcp reads it via
 * `--user-data-dir`, and both point Chromium at `sessionDir`. It lives under .intentic (outside the three repos,
 * gitignored, never committed) on the /work volume, so it survives a sandbox rebuild like claude.json does.
 *
 * EVERYTHING HERE IS KEYED BY THE CAPABILITY'S ID, NEVER BY ITS PLATFORM — that is what makes two accounts of
 * one site possible. A site is a card (reddit, npmjs); an account is a capability instance the owner named
 * (reddit-work, reddit-personal), and each one signs in separately, holds its own cookies and its own passkey,
 * and is disconnected on its own. Keyed by platform instead, a second Reddit connection would be born already
 * connected as the first, hand the agent two tool sets over one profile Chromium can only open once, and take
 * the other account's cookies down with it when removed. The capability id is unique by construction (the
 * manifest upserts by it) and already namespaces this account's skill and browser tools. */

// The Chromium `--user-data-dir` for one account.
export const sessionDir = (root: string, id: string): string => statePath(root, ".intentic/browser/", id);

// A completed-login marker, kept OUTSIDE the profile dir so Chromium never rewrites it. A bare profile dir
// exists the moment Chromium launches (before any login), so its presence can't mean "connected" — the marker,
// written only when the owner finishes the guided login, is the real "connected" probe.
const markerPath = (root: string, id: string): string => statePath(root, ".intentic/browser/", `${id}.connected`);

// The account's WebAuthn passkey store (passkeys.ts) — beside the profile because it is part of the same
// identity: the sandbox's own software security key for that account, exactly as sensitive as the profile's
// cookies and torn down with them.
export const passkeyPath = (root: string, id: string): string => statePath(root, ".intentic/browser/", `${id}.passkeys.json`);

export const hasSession = (root: string, id: string): boolean => existsSync(markerPath(root, id));

// Drop an empty marker beside the profile dir. Ensures the parent exists (it will after a real login, but this
// keeps the helper self-sufficient).
export const markConnected = async (root: string, id: string): Promise<void> => {
    const path = markerPath(root, id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
};

export const clearSession = async (root: string, id: string): Promise<void> => {
    await rm(sessionDir(root, id), { recursive: true, force: true });
    await rm(markerPath(root, id), { force: true });
    await rm(passkeyPath(root, id), { force: true });
};

// A persistent `--user-data-dir` can't be opened twice: while the owner has an account's profile open in their
// own window (signing in, or using the account by hand), the per-turn @playwright/mcp for THAT ACCOUNT must not
// spawn (and vice-versa). Per account rather than per site, so the owner can work in one Reddit account by hand
// while the agent drives the other. One daemon process, so a module-level set is the whole lock — no
// cross-process concern.
const profileLocks = new Set<string>();

export const isProfileOpen = (id: string): boolean => profileLocks.has(id);

export const acquireProfileLock = (id: string): boolean => {
    if (profileLocks.has(id)) {
        return false;
    }
    profileLocks.add(id);
    return true;
};

export const releaseProfileLock = (id: string): void => {
    profileLocks.delete(id);
};
