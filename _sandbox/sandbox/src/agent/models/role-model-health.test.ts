import type { UsageTurn } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import { failingStreak } from "./role-model-health.js";

const NOW = Date.parse("2026-09-08T12:00:00Z");

const turn = (over: Partial<UsageTurn>): UsageTurn => ({
    at: NOW - 60_000,
    day: "2026-09-08",
    provider: "gemini",
    harness: "native",
    outcome: "error",
    errorMessage: "Google turn timed out waiting for OpenCode.",
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 0,
    ...over,
});

const ledger = (rows: UsageTurn[]) => ({ turns: async () => rows });

describe("failingStreak", () => {
    test("three dead turns in a row on a provider name it, with the last sentence it gave", async () => {
        const rows = [turn({ at: NOW - 3_000 }), turn({ at: NOW - 2_000 }), turn({ at: NOW - 1_000 })];
        expect(await failingStreak(ledger(rows), { provider: "gemini" }, NOW)).toBe(
            "gemini: its last 3 turns here failed (Google turn timed out waiting for OpenCode.).",
        );
    });

    test("one good turn inside the streak clears it, and another provider's deaths do not count", async () => {
        const rows = [turn({ at: NOW - 3_000 }), turn({ at: NOW - 2_000, outcome: "ok" }), turn({ at: NOW - 1_000 })];
        expect(await failingStreak(ledger(rows), { provider: "gemini" }, NOW)).toBeUndefined();
        expect(await failingStreak(ledger(rows), { provider: "codex" }, NOW)).toBeUndefined();
    });

    test("a rate limit is the quota gate's verdict, not a streak, and old deaths fall out of the window", async () => {
        const limited = [turn({ at: NOW - 3_000, errorCode: "rate_limit" }), turn({ at: NOW - 2_000 }), turn({ at: NOW - 1_000 })];
        expect(await failingStreak(ledger(limited), { provider: "gemini" }, NOW)).toBeUndefined();
        const stale = [turn({ at: NOW - 3 * 60 * 60_000 }), turn({ at: NOW - 2_000 }), turn({ at: NOW - 1_000 })];
        expect(await failingStreak(ledger(stale), { provider: "gemini" }, NOW)).toBeUndefined();
    });

    test("a ledger that cannot be read blocks nothing", async () => {
        expect(
            await failingStreak(
                {
                    turns: async () => {
                        throw new Error("disk");
                    },
                },
                { provider: "gemini" },
                NOW,
            ),
        ).toBeUndefined();
    });
});
