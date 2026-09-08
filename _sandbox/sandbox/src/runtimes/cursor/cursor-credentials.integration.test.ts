import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createLogger } from "../../logger.js";
import { displayLabel, fileCursorStore, toAccount, usableCursorAccount } from "./cursor-credentials.js";

const DAY = 24 * 60 * 60_000;
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const newStore = () => fileCursorStore(mkdtempSync(join(tmpdir(), "cursor-store-")), logger);

// Clock pinned: assertions are about a key's remaining life, not wall-clock time.
const NOW = 1_800_000_000_000;
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
});

test("an account round-trips, and its row names the identity Cursor reported", async () => {
    const store = newStore();
    await store.write({ id: "a1", email: "dev@example.com", apiKey: "key-1", apiKeyExpiresAtMs: NOW + 90 * DAY, connectedAt: NOW });
    expect(await store.read("a1")).toMatchObject({ id: "a1", apiKey: "key-1" });
    expect(await store.list()).toEqual([{ id: "a1", label: "dev@example.com", email: "dev@example.com", connectedAt: NOW }]);
});

test("the key never reaches the shape the account list is made of", async () => {
    const store = newStore();
    await store.write({ id: "a1", apiKey: "key-1", connectedAt: NOW });
    expect(JSON.stringify(await store.list())).not.toContain("key-1");
    expect((await store.credentials())[0]?.apiKey).toBe("key-1");
});

test("a corrupt or foreign-shaped file reads as absent rather than throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-store-"));
    const store = fileCursorStore(dir, logger);
    await store.write({ id: "good", apiKey: "k", connectedAt: NOW });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "broken.json"), "{ not json");
    writeFileSync(join(dir, "foreign.json"), JSON.stringify({ hello: "world" }));
    expect((await store.list()).map((account) => account.id)).toEqual(["good"]);
});

test("accounts are listed oldest first, which is the one that serves a turn by default", async () => {
    const store = newStore();
    await store.write({ id: "second", apiKey: "k", connectedAt: NOW + 1000 });
    await store.write({ id: "first", apiKey: "k", connectedAt: NOW });
    expect((await store.list()).map((account) => account.id)).toEqual(["first", "second"]);
    expect((await usableCursorAccount(store, undefined))?.id).toBe("first");
});

test("an expiring key warns; only a dead one asks for a reconnect", () => {
    const healthy = toAccount({ id: "a", apiKey: "k", apiKeyExpiresAtMs: NOW + 30 * DAY, connectedAt: NOW });
    expect(healthy.needsReauth).toBeUndefined();
    expect(healthy.detail).toBeUndefined();

    const soon = toAccount({ id: "a", apiKey: "k", apiKeyExpiresAtMs: NOW + 2 * DAY, connectedAt: NOW });
    expect(soon.needsReauth).toBeUndefined();
    expect(soon.detail).toMatch(/2 day/i);

    const dead = toAccount({ id: "a", apiKey: "k", apiKeyExpiresAtMs: NOW - 1, connectedAt: NOW });
    expect(dead.needsReauth).toBe(true);
    expect(dead.detail).toMatch(/expir/i);
    expect(soon.detail).not.toBe(dead.detail);
});

test("no usage reading is ever claimed", () => {
    expect(toAccount({ id: "a", apiKey: "k", connectedAt: NOW }).usage).toBeUndefined();
});

test("a row names itself before it names the provider", () => {
    expect(displayLabel({ label: "Work", email: "dev@example.com" })).toBe("Work");
    expect(displayLabel({ label: "  ", email: "dev@example.com" })).toBe("dev@example.com");
    expect(displayLabel({ label: undefined, email: undefined })).toBe("Cursor");
});

test("a turn is never planned onto an expired key", async () => {
    const store = newStore();
    await store.write({ id: "dead", apiKey: "k", apiKeyExpiresAtMs: NOW - 1, connectedAt: NOW });
    await store.write({ id: "live", apiKey: "k", apiKeyExpiresAtMs: NOW + DAY, connectedAt: NOW + 1 });
    expect((await usableCursorAccount(store, undefined))?.id).toBe("live");
    expect(await usableCursorAccount(store, "dead")).toBeUndefined();
    expect((await usableCursorAccount(store, "live"))?.id).toBe("live");
});

test("a key with no stated expiry is usable, since nothing says otherwise", async () => {
    const store = newStore();
    await store.write({ id: "forever", apiKey: "k", connectedAt: NOW });
    expect((await usableCursorAccount(store, undefined))?.id).toBe("forever");
});

test("disconnecting one account leaves the others", async () => {
    const store = newStore();
    await store.write({ id: "a", apiKey: "k", connectedAt: NOW });
    await store.write({ id: "b", apiKey: "k", connectedAt: NOW + 1 });
    await store.clear("a");
    expect((await store.list()).map((account) => account.id)).toEqual(["b"]);
});

test("the stored file is owner-only, because the key in it is the whole credential", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-store-"));
    await fileCursorStore(dir, logger).write({ id: "a", apiKey: "k", connectedAt: NOW });
    expect(statSync(join(dir, "a.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, "a.json"), "utf8"))).toMatchObject({ apiKey: "k" });
});
