import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createLogger } from "../../logger.js";
import { fileCursorStore } from "./cursor-credentials.js";
import { cursorReadiness } from "./cursor-readiness.js";

// Cursor's three failure reasons look alike from outside; these tests pin the sentence, not just the boolean. The
// missing-runtime rung isn't reachable here (dev checkout has the real SDK); cursor-sdk.integration.test.ts owns that
// half.

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const newStore = () => fileCursorStore(mkdtempSync(join(tmpdir(), "cursor-ready-")), logger);

const NOW = 1_800_000_000_000;
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
});

test("nothing connected asks for a subscription, with the code that opens the connect gate", async () => {
    const readiness = await cursorReadiness(newStore());
    expect(readiness.ok).toBe(false);
    expect(readiness).toMatchObject({ code: "subscription-required" });
    expect(readiness.ok === false && readiness.detail).toContain("Connect your Cursor subscription");
});

test("an expired sign-in asks for a reconnect, and does not raise the connect gate", async () => {
    const store = newStore();
    await store.write({ id: "old", apiKey: "k", apiKeyExpiresAtMs: NOW - 1, connectedAt: NOW });
    const readiness = await cursorReadiness(store);
    expect(readiness.ok).toBe(false);
    expect(readiness).not.toMatchObject({ code: "subscription-required" });
    expect(readiness.ok === false && readiness.detail).toContain("expired");
});

test("one usable key among several dead ones is enough", async () => {
    const store = newStore();
    await store.write({ id: "dead", apiKey: "k", apiKeyExpiresAtMs: NOW - 1, connectedAt: NOW });
    await store.write({ id: "live", apiKey: "k", apiKeyExpiresAtMs: NOW + 60_000, connectedAt: NOW + 1 });
    expect(await cursorReadiness(store)).toEqual({ ok: true });
});
