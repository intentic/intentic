import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { BrowserConfig, Capability } from "@intentic/sandbox-contract";
import { publishRuntimeChange } from "../../seams/runtime-feed.js";
import { statePath } from "../../state-paths.js";

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

// Every copy store/json-file.ts set aside of a passkey store this build could not read (`.corrupt`, `.corrupt.<ms>`);
// private keys too, so each goes where the store goes. Suffixes, so a rename can carry each to the new owner.
const setAsidePasskeySuffixes = async (root: string, owner: string): Promise<string[]> => {
    const store = passkeyPath(root, owner);
    const names = (await readdir(dirname(store)).catch(undefinedIfMissing)) ?? [];
    return names.filter((name) => name.startsWith(`${basename(store)}.corrupt`)).map((name) => name.slice(basename(store).length));
};

export const hasSession = (root: string, id: string): boolean => existsSync(markerPath(root, id));

// Drops an empty marker beside the profile dir; ensures the parent dir exists first.
export const markConnected = async (root: string, id: string): Promise<void> => {
    const path = markerPath(root, id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
    publishRuntimeChange("capabilities");
};

// Tears down a profile owner's whole session: profile, passkeys, and its own marker.
// For an identity this removes the shared browser; sibling accounts' markers clear via their own removal.
export const clearSession = async (root: string, id: string): Promise<void> => {
    await rm(sessionDir(root, id), { recursive: true, force: true });
    await rm(markerPath(root, id), { force: true });
    await rm(passkeyPath(root, id), { force: true });
    for (const suffix of await setAsidePasskeySuffixes(root, id)) {
        await rm(`${passkeyPath(root, id)}${suffix}`, { force: true });
    }
    publishRuntimeChange("capabilities");
};

// Renames a profile owner's whole session (dir, marker, passkeys) rather than removing it, carrying every cookie to the
// new name. A part that isn't there is skipped; one that won't move throws, or the rename would strand the login.
export const moveSession = async (root: string, from: string, to: string): Promise<void> => {
    for (const path of [sessionDir, markerPath, passkeyPath]) {
        await rename(path(root, from), path(root, to)).catch(undefinedIfMissing);
    }
    for (const suffix of await setAsidePasskeySuffixes(root, from)) {
        await rename(`${passkeyPath(root, from)}${suffix}`, `${passkeyPath(root, to)}${suffix}`);
    }
    publishRuntimeChange("capabilities");
};

// Disconnects one entry without touching the profile it lives in; an identity-born account's shared browser and
// siblings stay.
// Site-side logout, if wanted, is done by hand in that browser.
export const clearMarker = async (root: string, id: string): Promise<void> => {
    await rm(markerPath(root, id), { force: true });
    publishRuntimeChange("capabilities");
};

// Renames one entry's marker only; it stays connected, and the profile it borrows doesn't change.
// Counterpart to clearMarker, as moveSession is to clearSession.
export const moveMarker = async (root: string, from: string, to: string): Promise<void> => {
    await rename(markerPath(root, from), markerPath(root, to)).catch(undefinedIfMissing);
    publishRuntimeChange("capabilities");
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
