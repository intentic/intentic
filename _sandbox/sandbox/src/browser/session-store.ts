import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserConfig, Capability } from "@intentic/sandbox-contract";
import { statePath } from "../workspace/state-paths.js";

/* A logged-in browser session for ONE PROFILE OWNER. The session IS a persistent Chromium profile: the owner's
 * own profile window (browser/browser-profile.ts) writes it, the agent's @playwright/mcp reads it via
 * `--user-data-dir`, and both point Chromium at `sessionDir`. It lives under .intentic (outside the three repos,
 * gitignored, never committed) on the /work volume, so it survives a sandbox rebuild like claude.json does.
 *
 * WHO OWNS A PROFILE: an IDENTITY when the account was born from one, the ACCOUNT itself otherwise. An identity
 * is one browser the way a person's is one — Google signed in beside Reddit and X, which is exactly what makes
 * a platform's "Continue with Google" a click instead of a second Google login the platform would block. An
 * account with no identity keeps its own private profile, so two accounts of one site (reddit-work,
 * reddit-personal) stay two containers: two identities, or two standalone profiles — never one profile with a
 * flag. `profileOwner` is the one place that rule lives; everything profile-shaped here (the dir, the passkeys,
 * the lock) is keyed by its answer.
 *
 * THE CONNECTED MARKER STAYS PER ENTRY, deliberately: "reddit-work is signed into Reddit" and "the identity's
 * browser is signed into Google" are facts about entries, not about the shared profile — three accounts in one
 * identity's browser connect (and disconnect) one at a time. Keyed by platform instead of entry, a second
 * Reddit connection would be born already connected as the first. */

// Whose profile an entry lives in: an identity-born account shares its identity's browser; an identity and a
// standalone account each own their own. The single source of the sharing rule — every profile path, lock and
// server grouping resolves through this.
export const profileOwner = (capability: Capability): string =>
    capability.kind === "browser" ? ((capability.config as BrowserConfig).identity ?? capability.id) : capability.id;

// The Chromium `--user-data-dir` for one profile owner (an identity id, or a standalone account's id).
export const sessionDir = (root: string, owner: string): string => statePath(root, ".intentic/local/browser/", owner);

// A completed-login marker, kept OUTSIDE the profile dir so Chromium never rewrites it. A bare profile dir
// exists the moment Chromium launches (before any login), so its presence can't mean "connected" — the marker,
// written only when the owner finishes the guided login, is the real "connected" probe.
const markerPath = (root: string, id: string): string => statePath(root, ".intentic/local/browser/", `${id}.connected`);

// The profile owner's WebAuthn passkey store (passkeys.ts) — beside the profile because it is part of the same
// someone: ONE software security key per browser, shared by every account living in it exactly as the cookies
// are, and torn down with them. Keyed by owner, not per account — a passkey enrolled on Reddit through an
// identity's browser is that identity's key.
export const passkeyPath = (root: string, owner: string): string => statePath(root, ".intentic/local/browser/", `${owner}.passkeys.json`);

export const hasSession = (root: string, id: string): boolean => existsSync(markerPath(root, id));

// Drop an empty marker beside the profile dir. Ensures the parent exists (it will after a real login, but this
// keeps the helper self-sufficient).
export const markConnected = async (root: string, id: string): Promise<void> => {
    const path = markerPath(root, id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
};

// Tear down a profile OWNER's whole session: the profile, the owner's passkeys, and its own marker. For an
// identity this is the shared browser going away — its accounts' markers are cleared by their own removals.
export const clearSession = async (root: string, id: string): Promise<void> => {
    await rm(sessionDir(root, id), { recursive: true, force: true });
    await rm(markerPath(root, id), { force: true });
    await rm(passkeyPath(root, id), { force: true });
};

/* Carry a profile owner's whole session onto a new name — a rename, where `clearSession` is a removal. Every
 * logged-in cookie the owner has is in that directory, so moving it is the difference between renaming a
 * connection and signing it out of everything it was signed into.
 *
 * Best-effort per part: a profile nobody has opened yet has no directory, an account that never finished its
 * login has no marker, and a browser with no passkey enrolled has no key file. None of those is a failure — the
 * rename of a connection that was never used is exactly the case with nothing to move. */
export const moveSession = async (root: string, from: string, to: string): Promise<void> => {
    for (const path of [sessionDir, markerPath, passkeyPath]) {
        await rename(path(root, from), path(root, to)).catch(() => undefined);
    }
};

// Disconnect ONE entry without touching the profile it lives in — what removing an identity-born account means:
// the shared browser (and every sibling signed in beside it) stays, only this account stops counting as
// connected. The site-side logout, if wanted, is the owner's or the agent's to do in that browser.
export const clearMarker = async (root: string, id: string): Promise<void> => {
    await rm(markerPath(root, id), { force: true });
};

// The same one entry, renamed: it stays connected, and the profile it borrows is none of its business. The
// counterpart of clearMarker, as moveSession is of clearSession.
export const moveMarker = async (root: string, from: string, to: string): Promise<void> => {
    await rename(markerPath(root, from), markerPath(root, to)).catch(() => undefined);
};

// A persistent `--user-data-dir` can't be opened twice: while the owner has a profile open in their own window
// (signing in, or using an account by hand), the per-turn @playwright/mcp for THAT PROFILE must not spawn (and
// vice-versa). Keyed by profile owner: two standalone accounts stay independently drivable, and an identity's
// browser is ONE browser — the owner holding it parks the agent for every account inside it, the same way a
// person's own browser has one keyboard. One daemon process, so a module-level set is the whole lock — no
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
