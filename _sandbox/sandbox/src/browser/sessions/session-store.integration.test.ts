import { existsSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import {
    acquireProfileLock,
    clearMarker,
    clearSession,
    hasSession,
    isProfileOpen,
    markConnected,
    passkeyPath,
    profileOwner,
    releaseProfileLock,
    sessionDir,
} from "./session-store.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "browser-sess-"));

test("sessionDir is the account's profile under .intentic/local/browser", () => {
    const root = WORKSPACE_ROOT;
    expect(sessionDir(root, "reddit")).toBe(join(root, ".intentic", "local", "browser", "reddit"));
});

test("hasSession flips on the connected marker; clearSession resets it", async () => {
    const root = tempRoot();
    expect(hasSession(root, "reddit")).toBe(false);
    await markConnected(root, "reddit");
    expect(hasSession(root, "reddit")).toBe(true);
    // Per-account: connecting reddit doesn't connect x.
    expect(hasSession(root, "x")).toBe(false);
    await clearSession(root, "reddit");
    expect(hasSession(root, "reddit")).toBe(false);
});

test("accounts of the same site connect, and disconnect, independently", async () => {
    const root = tempRoot();
    expect(sessionDir(root, "reddit-work")).not.toBe(sessionDir(root, "reddit-personal"));

    await markConnected(root, "reddit-work");
    // Not born connected off the first account's login.
    expect(hasSession(root, "reddit-personal")).toBe(false);

    await markConnected(root, "reddit-personal");
    await writeFile(passkeyPath(root, "reddit-work"), JSON.stringify({ credentials: [] }));
    await writeFile(passkeyPath(root, "reddit-personal"), JSON.stringify({ credentials: [] }));

    // Disconnecting one leaves the other signed in, passkey included.
    await clearSession(root, "reddit-work");
    expect(hasSession(root, "reddit-work")).toBe(false);
    expect(existsSync(passkeyPath(root, "reddit-work"))).toBe(false);
    expect(hasSession(root, "reddit-personal")).toBe(true);
    expect(existsSync(passkeyPath(root, "reddit-personal"))).toBe(true);
});

test("the passkey store sits beside the profile and is cleared with the session", async () => {
    const root = tempRoot();
    expect(passkeyPath(root, "npmjs")).toBe(join(root, ".intentic", "local", "browser", "npmjs.passkeys.json"));
    await markConnected(root, "npmjs");
    await writeFile(passkeyPath(root, "npmjs"), JSON.stringify({ credentials: [] }));
    expect(existsSync(passkeyPath(root, "npmjs"))).toBe(true);
    await clearSession(root, "npmjs");
    expect(existsSync(passkeyPath(root, "npmjs"))).toBe(false);
});

test("the login lock is exclusive per account", () => {
    expect(isProfileOpen("youtube")).toBe(false);
    expect(acquireProfileLock("youtube")).toBe(true);
    expect(isProfileOpen("youtube")).toBe(true);
    // One guided login at a time per account: a second acquire while held fails.
    expect(acquireProfileLock("youtube")).toBe(false);
    // Different accounts, even of the same site, lock independently.
    expect(acquireProfileLock("reddit-work")).toBe(true);
    expect(acquireProfileLock("reddit-personal")).toBe(true);
    releaseProfileLock("youtube");
    releaseProfileLock("reddit-work");
    releaseProfileLock("reddit-personal");
    expect(isProfileOpen("youtube")).toBe(false);
});

// Identity as profile owner.

test("profileOwner: identity-born accounts share the identity's browser; everything else owns its own", () => {
    const identity: Capability = { id: "main", kind: "identity", config: { email: "me@gmail.com", openAccounts: "off" } };
    const born: Capability = { id: "reddit-main", kind: "browser", config: { platform: "reddit", identity: "main" } };
    const standalone: Capability = { id: "reddit-personal", kind: "browser", config: { platform: "reddit" } };
    expect(profileOwner(identity)).toBe("main");
    expect(profileOwner(born)).toBe("main");
    expect(profileOwner(standalone)).toBe("reddit-personal");
    // Same paths: the born account and its identity share a profile dir and passkey store.
    const root = tempRoot();
    expect(sessionDir(root, profileOwner(born))).toBe(sessionDir(root, profileOwner(identity)));
    expect(passkeyPath(root, profileOwner(born))).toBe(passkeyPath(root, profileOwner(identity)));
});

// clearMarker removes only the entry's marker; profile and passkeys belong to the identity and stay.
// clearSession is the full teardown, for the owner itself.
test("clearMarker disconnects one entry without touching the shared profile", async () => {
    const root = tempRoot();
    await markConnected(root, "main");
    await markConnected(root, "reddit-main");
    await markConnected(root, "x-main");
    await writeFile(passkeyPath(root, "main"), JSON.stringify({ credentials: [] }));

    await clearMarker(root, "reddit-main");
    expect(hasSession(root, "reddit-main")).toBe(false);
    expect(hasSession(root, "main")).toBe(true);
    expect(hasSession(root, "x-main")).toBe(true);
    expect(existsSync(passkeyPath(root, "main"))).toBe(true);
});
