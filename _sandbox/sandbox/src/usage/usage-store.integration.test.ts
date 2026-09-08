import { mkdtempSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileUsageStore, utcDay } from "./usage-store.js";

const storePath = (): string => join(mkdtempSync(join(tmpdir(), "usage-")), "usage.jsonl");

// A turn's default numbers; each case overrides only the fields it varies.
const turn = (over: Partial<Parameters<ReturnType<typeof fileUsageStore>["record"]>[0]> = {}) => ({
    provider: "claude",
    harness: "native",
    turns: 1,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
    costUsd: 0.25,
    durationMs: 1_000,
    ...over,
});

const DAY_ONE = Date.UTC(2026, 6, 20, 12, 0, 0);
const DAY_TWO = Date.UTC(2026, 6, 21, 12, 0, 0);

test("record stamps at + day; rollup groups by day, provider, account, model and harness", async () => {
    let clock = DAY_ONE;
    const store = fileUsageStore(storePath(), () => clock);

    await store.record(turn({ account: "work", model: "opus-5" }));
    await store.record(turn({ account: "work", model: "opus-5" }));
    await store.record(turn({ account: "work", model: "sonnet-5", costUsd: 0.05 }));
    clock = DAY_TWO;
    await store.record(turn({ account: "work", model: "opus-5", costUsd: 1 }));

    const rows = await store.rollup({});
    expect(rows).toHaveLength(3);

    const opusDayOne = rows.find((row) => row.day === "2026-07-20" && row.model === "opus-5");
    expect(opusDayOne).toMatchObject({ turns: 2, inputTokens: 200, outputTokens: 100, costUsd: 0.5, durationMs: 2_000 });

    expect(rows.find((row) => row.day === "2026-07-20" && row.model === "sonnet-5")).toMatchObject({ turns: 1, costUsd: 0.05 });
    expect(rows.find((row) => row.day === "2026-07-21")).toMatchObject({ model: "opus-5", turns: 1, costUsd: 1 });
    expect(rows.map((row) => row.day)).toEqual(["2026-07-20", "2026-07-20", "2026-07-21"]);
});

test("rollup filters on inclusive UTC day bounds", async () => {
    let clock = Date.UTC(2026, 6, 19, 12, 0, 0);
    const store = fileUsageStore(storePath(), () => clock);
    await store.record(turn({ costUsd: 1 }));
    clock = DAY_ONE;
    await store.record(turn({ costUsd: 2 }));
    clock = DAY_TWO;
    await store.record(turn({ costUsd: 4 }));

    const windowed = await store.rollup({ from: "2026-07-20", to: "2026-07-21" });
    expect(windowed.map((row) => row.costUsd)).toEqual([2, 4]);
    expect(await store.rollup({ from: "2026-07-21" })).toHaveLength(1);
    expect(await store.rollup({ to: "2026-07-19" })).toHaveLength(1);
    expect(await store.rollup({ from: "2026-08-01" })).toEqual([]);
});

test("absent account and model stay absent rather than becoming an explicit undefined", async () => {
    const store = fileUsageStore(storePath(), () => DAY_ONE);
    await store.record(turn());

    const [row] = await store.rollup({});
    expect(row).toEqual(expect.any(Object));
    expect("account" in (row ?? {})).toBe(false);
    expect("model" in (row ?? {})).toBe(false);
    expect(row).toMatchObject({ provider: "claude", turns: 1, costUsd: 0.25 });
});

test("an unattributed turn groups separately from an attributed one on the same day", async () => {
    const store = fileUsageStore(storePath(), () => DAY_ONE);
    await store.record(turn({ account: "work" }));
    await store.record(turn());

    expect(await store.rollup({})).toHaveLength(2);
});

test("the conversation is part of the key, so cost-by-agent is answerable within a window", async () => {
    let clock = DAY_ONE;
    const store = fileUsageStore(storePath(), () => clock);
    await store.record(turn({ conversationId: "agent-a", costUsd: 1 }));
    await store.record(turn({ conversationId: "agent-a", costUsd: 2 }));
    await store.record(turn({ conversationId: "agent-b", costUsd: 4 }));
    // A turn with no conversationId is its own row, not pooled under a blank id.
    await store.record(turn({ costUsd: 8 }));
    clock = DAY_TWO;
    await store.record(turn({ conversationId: "agent-a", costUsd: 16 }));

    const all = await store.rollup({});
    expect(all).toHaveLength(4);
    expect(all.filter((row) => row.conversationId === "agent-a").map((row) => row.costUsd)).toEqual([3, 16]);
    expect(all.find((row) => row.conversationId === undefined)).toMatchObject({ costUsd: 8 });
    expect("conversationId" in (all.find((row) => row.costUsd === 8) ?? {})).toBe(false);

    const dayTwo = await store.rollup({ from: "2026-07-21" });
    expect(dayTwo).toEqual([expect.objectContaining({ conversationId: "agent-a", costUsd: 16 })]);
});

test("a corrupt line is skipped, never the ledger", async () => {
    const path = storePath();
    const store = fileUsageStore(path, () => DAY_ONE);
    await store.record(turn({ costUsd: 1 }));
    await appendFile(path, "{torn line\n");
    await store.record(turn({ costUsd: 2 }));

    const rows = await store.rollup({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turns: 2, costUsd: 3 });
});

test("the ledger is never pruned: an old day survives an arbitrary number of newer turns", async () => {
    const path = storePath();
    let clock = DAY_ONE;
    const store = fileUsageStore(path, () => clock);
    await store.record(turn({ costUsd: 7 }));

    clock = DAY_TWO;
    for (let index = 0; index < 500; index++) {
        await store.record(turn({ costUsd: 0.01 }));
    }

    const rows = await store.rollup({});
    expect(rows[0]).toMatchObject({ day: "2026-07-20", costUsd: 7 });
    expect((await readFile(path, "utf8")).split("\n").filter((line) => line !== "")).toHaveLength(501);
});

test("rollup on a ledger that was never written is empty, not a failure", async () => {
    expect(await fileUsageStore(storePath()).rollup({})).toEqual([]);
});

test("a failed turn is kept whole by the ledger and left out of the money rollup", async () => {
    const store = fileUsageStore(storePath(), () => DAY_ONE);
    await store.record(turn({ account: "work", model: "opus-5" }));
    // A turn refused before the provider charged anything has no usage frame, so every field is zero.
    await store.record(
        turn({
            account: "work",
            model: "opus-5",
            outcome: "error",
            errorCode: "claude-not-entitled",
            errorMessage: "Claude Code is not enabled for this organization",
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0,
            durationMs: 0,
        }),
    );

    const rows = await store.rollup({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turns: 1, costUsd: 0.25 });

    const turns = await store.turns({});
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
        outcome: "error",
        errorCode: "claude-not-entitled",
        errorMessage: "Claude Code is not enabled for this organization",
    });
});

test("a turn the provider counted but charged nothing for still counts as spend", async () => {
    const store = fileUsageStore(storePath(), () => DAY_ONE);
    // Billing counts `turns`, not `costUsd`; a flat-plan exchange with no charge still counts.
    await store.record(turn({ outcome: "ok", costUsd: 0 }));

    expect(await store.rollup({})).toMatchObject([{ turns: 1, costUsd: 0 }]);
});

test("a cancelled turn keeps what it spent before the user stopped it", async () => {
    const store = fileUsageStore(storePath(), () => DAY_ONE);
    await store.record(turn({ outcome: "cancelled", costUsd: 0.1 }));

    expect(await store.rollup({})).toMatchObject([{ turns: 1, costUsd: 0.1 }]);
    expect((await store.turns({}))[0]).toMatchObject({ outcome: "cancelled" });
});

test("the model asked for is recorded beside the one that ran, so a routing surprise is a diff", async () => {
    const store = fileUsageStore(storePath(), () => DAY_ONE);
    await store.record(turn({ modelRequested: "opus-4-6-thinking", model: "grok-4" }));

    const [row] = await store.turns({});
    expect(row).toMatchObject({ modelRequested: "opus-4-6-thinking", model: "grok-4" });
});

test("utcDay buckets by UTC, not the host zone", () => {
    expect(utcDay(Date.UTC(2026, 6, 20, 23, 59, 59))).toBe("2026-07-20");
    expect(utcDay(Date.UTC(2026, 6, 21, 0, 0, 0))).toBe("2026-07-21");
});
