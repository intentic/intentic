import { expect, test } from "vitest";
import { checks } from "./invariant.js";
import type { JournalEntry, TurnJournal } from "./turn-journal.js";

/* The window this check exists to close: a turn is running, its journal write was swallowed, and the next
 * container recreate — an update, an environment approval, a dev swap — ends it with nothing to resume from. */

const fail = (message: string): never => {
    throw new Error(message);
};

const NOW = 1_800_000_000_000;

const journalOf = (entries: readonly JournalEntry[]): TurnJournal => ({
    list: async () => [...entries],
    recordTurn: async () => {},
    recordFire: async () => {},
    clearTurn: async () => {},
    clearFire: async () => {},
});

const entryFor = (conversationId: string): JournalEntry => ({
    kind: "turn",
    startedAt: NOW,
    attempts: 0,
    turn: { conversationId, prompt: "go" },
});

const run = async (entries: readonly JournalEntry[], live: readonly { conversationId: string; startedAt: number }[]): Promise<void> => {
    const [check] = checks({ turnJournal: journalOf(entries), live: () => live, now: () => NOW });
    await check?.run({ moment: "sweep", fail });
};

test("a live turn with its entry on disk reports nothing", async () => {
    await expect(run([entryFor("c1")], [{ conversationId: "c1", startedAt: NOW - 60_000 }])).resolves.toBeUndefined();
});

test("a live turn with no journal entry is named", async () => {
    await expect(run([], [{ conversationId: "c1", startedAt: NOW - 60_000 }])).rejects.toThrow(/1 live turn\(s\).*c1/);
});

test("a turn younger than the grace is not yet due — the write is queued, not lost", async () => {
    await expect(run([], [{ conversationId: "c1", startedAt: NOW - 1_000 }])).resolves.toBeUndefined();
});

test("no live turns is not a finding, whatever the journal holds", async () => {
    // At boot the journal is the previous life's and the live map is empty. That disagreement is the journal
    // working, which is why this check does not run at boot and must not fire when it is armed at a sweep
    // moments after one.
    await expect(run([entryFor("gone")], [])).resolves.toBeUndefined();
});

test("an automation fire's entry does not count as a chat turn's", async () => {
    const fire: JournalEntry = { kind: "automation", startedAt: NOW, attempts: 0, automationId: "c1", conversationId: "c1" };
    await expect(run([fire], [{ conversationId: "c1", startedAt: NOW - 60_000 }])).rejects.toThrow(/c1/);
});
