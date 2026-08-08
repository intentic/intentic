import { existsSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
    acquireProfileLock,
    clearSession,
    hasSession,
    isProfileOpen,
    markConnected,
    passkeyPath,
    releaseProfileLock,
    sessionDir,
} from "./session-store.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "browser-sess-"));

test("sessionDir is the account's profile under .intentic/browser", () => {
    const root = "/work";
    expect(sessionDir(root, "reddit")).toBe(join(root, ".intentic", "browser", "reddit"));
});

test("hasSession flips on the connected marker; clearSession resets it", async () => {
    const root = tempRoot();
    expect(hasSession(root, "reddit")).toBe(false);
    await markConnected(root, "reddit");
    expect(hasSession(root, "reddit")).toBe(true);
    // Marker is per-account — connecting reddit doesn't connect x.
    expect(hasSession(root, "x")).toBe(false);
    await clearSession(root, "reddit");
    expect(hasSession(root, "reddit")).toBe(false);
});

/* TWO ACCOUNTS OF ONE SITE ARE TWO SESSIONS. Keyed by platform instead of by capability id, the second Reddit
 * connection would read as already logged in the moment it was added (inheriting the first account's cookies),
 * would hand the agent two tool prefixes over a profile Chromium can only open once, and would take the other
 * account down with it when disconnected. Every one of those is checked here, because every one of them is a
 * thing a user would do on day one of having a work account and a personal one. */
test("accounts of the same site connect, and disconnect, independently", async () => {
    const root = tempRoot();
    expect(sessionDir(root, "reddit-work")).not.toBe(sessionDir(root, "reddit-personal"));

    await markConnected(root, "reddit-work");
    // The second account is NOT born connected off the first one's login.
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

// The passkey is part of the account's identity, not a separate thing to forget: disconnecting has to take the
// sandbox's software security key with the cookies, or a removed account leaves a usable second factor behind.
test("the passkey store sits beside the profile and is cleared with the session", async () => {
    const root = tempRoot();
    expect(passkeyPath(root, "npmjs")).toBe(join(root, ".intentic", "browser", "npmjs.passkeys.json"));
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
    // A second acquire while held fails — one guided login at a time per account.
    expect(acquireProfileLock("youtube")).toBe(false);
    // A different account is unaffected — including a second account of the same site, which is what lets the
    // owner sit in one Reddit by hand while the agent works in the other.
    expect(acquireProfileLock("reddit-work")).toBe(true);
    expect(acquireProfileLock("reddit-personal")).toBe(true);
    releaseProfileLock("youtube");
    releaseProfileLock("reddit-work");
    releaseProfileLock("reddit-personal");
    expect(isProfileOpen("youtube")).toBe(false);
});
