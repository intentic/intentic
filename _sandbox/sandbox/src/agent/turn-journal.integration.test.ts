import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileTurnJournal } from "./turn-journal.js";

const journalDir = (): string => join(mkdtempSync(join(tmpdir(), "journal-")), "turns");

test("both kinds round-trip, are filed under their own id, and clear independently", async () => {
    const dir = journalDir();
    const journal = fileTurnJournal(dir);
    expect(await journal.list()).toEqual([]);

    await journal.recordTurn({
        kind: "turn",
        turn: { conversationId: "c-1", prompt: "ship it" },
        sessionId: "sess-1",
        startedAt: 10,
        attempts: 0,
    });
    await journal.recordFire({
        kind: "automation",
        automationId: "nightly",
        conversationId: "a-nightly-1",
        payload: "ping",
        startedAt: 20,
        attempts: 0,
    });

    expect((await journal.list()).map((entry) => entry.kind).toSorted()).toEqual(["automation", "turn"]);

    // A second turn on the same conversation REPLACES the entry rather than adding one: the filing is by
    // conversation, which is what makes a failed clear self-healing instead of a leak.
    await journal.recordTurn({ kind: "turn", turn: { conversationId: "c-1", prompt: "again" }, startedAt: 30, attempts: 1 });
    const turns = (await journal.list()).filter((entry) => entry.kind === "turn");
    expect(turns).toHaveLength(1);
    // The replacement is whole, not a merge: the first turn's session must not survive onto the second.
    expect(turns[0]).toEqual({ kind: "turn", startedAt: 30, attempts: 1, turn: { conversationId: "c-1", prompt: "again" } });

    // The two prefixes are separate namespaces: clearing the conversation leaves the automation alone.
    await journal.clearTurn("c-1");
    expect((await journal.list()).map((entry) => entry.kind)).toEqual(["automation"]);
    await journal.clearFire("nightly");
    expect(await journal.list()).toEqual([]);
});

test("clearing what isn't there is a no-op: a turn that settles twice must not throw", async () => {
    const journal = fileTurnJournal(journalDir());
    await expect(journal.clearTurn("never-ran")).resolves.toBeUndefined();
    await expect(journal.clearFire("never-fired")).resolves.toBeUndefined();
});

test("an unreadable entry is skipped and LEFT, never deleted; a foreign filename is ignored too", async () => {
    const dir = journalDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "t-broken.json"), "{ not json");
    writeFileSync(join(dir, "t-wrong-shape.json"), JSON.stringify({ kind: "turn", startedAt: 1 }));
    // Not id-shaped, so not even opened.
    writeFileSync(join(dir, "..evil.json"), JSON.stringify({ kind: "turn" }));
    writeFileSync(join(dir, "notes.txt"), "hello");
    // One good entry alongside them: a bad neighbour must not cost a resumable turn.
    const journal = fileTurnJournal(dir);
    await journal.recordFire({ kind: "automation", automationId: "fine", conversationId: "a-fine-1", startedAt: 1, attempts: 0 });

    expect((await journal.list()).map((entry) => entry.kind)).toEqual(["automation"]);

    /* Reading is not the moment to destroy a record. A file caught mid-write parses as garbage for an instant,
     * and a lister that unlinked on a failed parse would delete the live entry of a turn that had only just
     * started, which is exactly the turn the journal exists to protect. */
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).toSorted()).toEqual(["..evil.json", "a-fine.json", "notes.txt", "t-broken.json", "t-wrong-shape.json"]);
});
