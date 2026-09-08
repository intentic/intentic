import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserConfig, Capability } from "@intentic/sandbox-contract";
import { statePath } from "../../workspace/layout/state-paths.js";

// A logged-in session for one profile owner is a persistent Chromium profile at sessionDir, written by
// browser-profile.ts and read by @playwright/mcp via --user-data-dir; lives under .intentic on /work, gitignored,
// surviving a rebuild.
// profileOwner is an identity if the account was born from one, else the account itself: identities share one browser
// (so Continue-with-Google works), standalone accounts each keep their own profile.
// The connected marker is kept per entry, not per profile: accounts sharing an identity's browser connect and
// disconnect independently.

// Profile owner for an entry: an identity-born account shares its identity's browser, otherwise it owns itself.
// Single source of the sharing rule; every profile path, lock and server grouping resolves through this.
export const profileOwner = (capability: Capability): string =>
    capability.kind === "browser" ? ((capability.config as BrowserConfig).identity ?? capability.id) : capability.id;

// Chromium --user-data-dir for one profile owner (an identity id, or a standalone account's id).
export const sessionDir = (root: string, owner: string): string => statePath(root, ".intentic/local/browser/", owner);

// Completed-login marker, kept outside the profile dir: a bare dir exists before any login and can't mean connected.
const markerPath = (root: string, id: string): string => statePath(root, ".intentic/local/browser/", `${id}.connected`);

// Profile owner's WebAuthn passkey store, beside the profile: one key per browser, shared and torn down with its
// accounts.
export const passkeyPath = (root: string, owner: string): string => statePath(root, ".intentic/local/browser/", `${owner}.passkeys.json`);

export const hasSession = (root: string, id: string): boolean => existsSync(markerPath(root, id));

// Drops an empty marker beside the profile dir; ensures the parent dir exists first.
export const markConnected = async (root: string, id: string): Promise<void> => {
    const path = markerPath(root, id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
};

// Tears down a profile owner's whole session: profile, passkeys, and its own marker.
// For an identity this removes the shared browser; sibling accounts' markers clear via their own removal.
export const clearSession = async (root: string, id: string): Promise<void> => {
    await rm(sessionDir(root, id), { recursive: true, force: true });
    await rm(markerPath(root, id), { force: true });
    await rm(passkeyPath(root, id), { force: true });
};

// Renames a profile owner's whole session (dir, marker, passkeys) rather than removing it, carrying every cookie to the
// new name.
// Best-effort per part: an unused connection has nothing to move, which isn't a failure.
export const moveSession = async (root: string, from: string, to: string): Promise<void> => {
    for (const path of [sessionDir, markerPath, passkeyPath]) {
        await rename(path(root, from), path(root, to)).catch(() => undefined);
    }
};

// Disconnects one entry without touching the profile it lives in; an identity-born account's shared browser and
// siblings stay.
// Site-side logout, if wanted, is done by hand in that browser.
export const clearMarker = async (root: string, id: string): Promise<void> => {
    await rm(markerPath(root, id), { force: true });
};

// Renames one entry's marker only; it stays connected, and the profile it borrows doesn't change.
// Counterpart to clearMarker, as moveSession is to clearSession.
export const moveMarker = async (root: string, from: string, to: string): Promise<void> => {
    await rename(markerPath(root, from), markerPath(root, to)).catch(() => undefined);
};

// Persistent profile can't open twice; locked by owner, one lock covers every account in an identity's browser.
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
