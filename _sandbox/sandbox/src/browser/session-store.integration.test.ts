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

test("sessionDir is the platform's profile under .intentic/browser", () => {
    const root = "/work";
    expect(sessionDir(root, "reddit")).toBe(join(root, ".intentic", "browser", "reddit"));
});

test("hasSession flips on the connected marker; clearSession resets it", async () => {
    const root = tempRoot();
    expect(hasSession(root, "reddit")).toBe(false);
    await markConnected(root, "reddit");
    expect(hasSession(root, "reddit")).toBe(true);
    // Marker is per-platform — connecting reddit doesn't connect x.
    expect(hasSession(root, "x")).toBe(false);
    await clearSession(root, "reddit");
    expect(hasSession(root, "reddit")).toBe(false);
});

// The passkey is part of the platform's identity, not a separate thing to forget: disconnecting has to take the
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

test("the login lock is exclusive per platform", () => {
    expect(isProfileOpen("youtube")).toBe(false);
    expect(acquireProfileLock("youtube")).toBe(true);
    expect(isProfileOpen("youtube")).toBe(true);
    // A second acquire while held fails — one guided login at a time per platform.
    expect(acquireProfileLock("youtube")).toBe(false);
    // A different platform is unaffected.
    expect(acquireProfileLock("reddit")).toBe(true);
    releaseProfileLock("youtube");
    releaseProfileLock("reddit");
    expect(isProfileOpen("youtube")).toBe(false);
});
