import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { IssueReport } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { fileIssuesStore, type RecordInput } from "./issues-store.js";

// A store over a fresh temp path (the issues dir doesn't exist yet: the store must create it on write).
const tempStore = () => {
    const dir = join(mkdtempSync(join(tmpdir(), "issues-")), `${STATE_DIR}`, "records", "issues");
    return { store: fileIssuesStore(dir), dir };
};

const report = (over: Partial<IssueReport> = {}): IssueReport => ({ kind: "crash", message: "TypeError: x is not a function", ...over });

const arriving = (over: Partial<RecordInput> = {}): RecordInput => ({
    id: "abc123",
    automationId: "bugs",
    report: report(),
    now: 1_000,
    escalateAfter: 10,
    ...over,
});

test("the first arrival opens a group; the id is the filename and never in the body", async () => {
    const { store, dir } = tempStore();
    expect(await store.list()).toEqual({ issues: [], invalid: [] });

    const first = await store.record(arriving({ origin: "https://shop.example" }));
    expect(first.fresh).toBe(true);
    expect(first.escalated).toBe(false);
    expect(first.issue).toMatchObject({ id: "abc123", count: 1, status: "open", firstSeen: 1_000, lastSeen: 1_000, origin: "https://shop.example" });
    expect(first.issue.title).toBe("TypeError: x is not a function");
    expect(JSON.parse(await readFile(join(dir, "abc123.json"), "utf8"))).not.toHaveProperty("id");
});

// Nine more browsers on one bug must be nine silent counts, not nine wakes, or a crash loop becomes a bill. The tenth
// crosses the escalation step.
test("a recurrence counts silently until it has grown by the escalation step", async () => {
    const { store } = tempStore();
    await store.record(arriving());
    for (let n = 2; n <= 9; n += 1) {
        const outcome = await store.record(arriving({ now: 1_000 + n }));
        expect({ n, ...outcome }).toMatchObject({ n, fresh: false, escalated: false });
    }
    // firedAt unset means the step is measured from zero, so the tenth arrival is the one that crosses it.
    const tenth = await store.record(arriving({ now: 1_100 }));
    expect(tenth.escalated).toBe(true);
    expect(tenth.issue).toMatchObject({ count: 10, lastSeen: 1_100, firstSeen: 1_000 });

    // Once a wake is stamped, the step restarts counting from that count, not from zero.
    await store.noteRun("abc123", "bug-bugs-abc123", 1_200);
    const afterWake = await store.record(arriving({ now: 1_300 }));
    expect(afterWake.escalated).toBe(false);
    expect(afterWake.issue.count).toBe(11);
});

test("a run is linked, stamps the count it started at, and moves the row to being looked at", async () => {
    const { store } = tempStore();
    await store.record(arriving());
    await store.record(arriving({ now: 1_001 }));
    await store.noteRun("abc123", "bug-bugs-abc123", 2_000);
    const issue = await store.read("abc123");
    expect(issue).toMatchObject({ status: "investigating", statusAt: 2_000, firedAt: 2 });
    expect(issue?.runs).toEqual([{ conversationId: "bug-bugs-abc123", at: 2_000, atCount: 2 }]);
});

// A resolved group that recurs reopens and re-escalates from scratch; waiting for the old count to grow by ten more
// would swallow the recurrence that long.
test("a resolved issue that happens again reopens and escalates at once; an ignored one stays ignored", async () => {
    const { store } = tempStore();
    await store.record(arriving());
    await store.noteRun("abc123", "c1", 2_000);
    await store.setStatus("abc123", "resolved", 3_000);

    const back = await store.record(arriving({ now: 4_000 }));
    expect(back.issue).toMatchObject({ status: "open", statusAt: 4_000, count: 2 });
    expect(back.issue.firedAt).toBeUndefined();
    expect(back.escalated).toBe(true);

    await store.setStatus("abc123", "ignored", 5_000);
    const ignored = await store.record(arriving({ now: 6_000 }));
    // Ignored still counts; only the status stays put.
    expect(ignored.issue).toMatchObject({ status: "ignored", count: 3 });
});

// A fix must reproduce what the crash looks like now, not its first sample, often from a build that's gone.
test("the sample and the release are replaced by the latest, the timestamps keep both ends", async () => {
    const { store } = tempStore();
    await store.record(arriving({ report: report({ release: "v1", stack: "    at old (https://s/a.js:1:1)" }) }));
    const second = await store.record(arriving({ now: 9_000, report: report({ release: "v2", message: "TypeError: x is not a function (v2)" }) }));
    expect(second.issue.release).toBe("v2");
    expect(second.issue.sample.message).toBe("TypeError: x is not a function (v2)");
    expect(second.issue).toMatchObject({ firstSeen: 1_000, lastSeen: 9_000 });
});

// The traffic this is built for: many browsers hitting one broken page in the same second. Unserialized
// read-modify-write would undercount badly.
test("simultaneous arrivals of one crash all count", async () => {
    const { store } = tempStore();
    const outcomes = await Promise.all(Array.from({ length: 25 }, (_unused, n) => store.record(arriving({ now: 1_000 + n }))));
    expect((await store.read("abc123"))?.count).toBe(25);
    expect(outcomes.filter((outcome) => outcome.fresh)).toHaveLength(1);
});

test("triage moves a row, and a missing id is reported rather than invented", async () => {
    const { store } = tempStore();
    await store.record(arriving());
    expect(await store.setStatus("abc123", "resolved", 7_000)).toMatchObject({ status: "resolved", statusAt: 7_000 });
    expect(await store.setStatus("nope", "resolved", 7_000)).toBeUndefined();
    expect(await store.remove("abc123")).toBe(true);
    expect(await store.remove("abc123")).toBe(false);
});

// Newest-down ordering uses when a group was last seen, not when it began.
test("the list is ordered by when each group was last seen", async () => {
    const { store } = tempStore();
    await store.record(arriving({ id: "old", now: 1_000 }));
    await store.record(arriving({ id: "new", now: 5_000 }));
    await store.record(arriving({ id: "old", now: 9_000 }));
    expect((await store.list()).issues.map((issue) => issue.id)).toEqual(["old", "new"]);
});
