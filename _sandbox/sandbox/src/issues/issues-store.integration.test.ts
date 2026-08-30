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
    // Derived, not typed: the title comes off the report so two arrivals cannot be filed under two names.
    expect(first.issue.title).toBe("TypeError: x is not a function");
    expect(JSON.parse(await readFile(join(dir, "abc123.json"), "utf8"))).not.toHaveProperty("id");
});

/* THE TEST THIS MODULE EXISTS FOR. Nine more browsers hitting one bug must be nine counts and NO wakes: with a
 * wake each, a crash loop on a popular page is a bill rather than a bug report. The tenth crosses the step. */
test("a recurrence counts silently until it has grown by the escalation step", async () => {
    const { store } = tempStore();
    await store.record(arriving());
    for (let n = 2; n <= 9; n += 1) {
        const outcome = await store.record(arriving({ now: 1_000 + n }));
        expect({ n, ...outcome }).toMatchObject({ n, fresh: false, escalated: false });
    }
    // Nothing has woken yet, so `firedAt` is unset and the step is measured from zero: the tenth arrival is it.
    const tenth = await store.record(arriving({ now: 1_100 }));
    expect(tenth.escalated).toBe(true);
    expect(tenth.issue).toMatchObject({ count: 10, lastSeen: 1_100, firstSeen: 1_000 });

    // Once a wake is stamped, the step restarts from that count rather than from zero.
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

/* "We fixed it and it came back" is the most important thing this inbox can say, so a resolved group that
 * happens again reopens AND re-enters the escalation rule from scratch: waiting for the old count to grow by
 * another ten would swallow the recurrence for as long as it took to happen ten more times. */
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
    // The owner said they know and do not care. The count still moves; the status does not.
    expect(ignored.issue).toMatchObject({ status: "ignored", count: 3 });
});

// When a crash is still happening, what it looks like NOW is what a fix has to reproduce; the first sample is
// often from a build that no longer exists.
test("the sample and the release are replaced by the latest, the timestamps keep both ends", async () => {
    const { store } = tempStore();
    await store.record(arriving({ report: report({ release: "v1", stack: "    at old (https://s/a.js:1:1)" }) }));
    const second = await store.record(arriving({ now: 9_000, report: report({ release: "v2", message: "TypeError: x is not a function (v2)" }) }));
    expect(second.issue.release).toBe("v2");
    expect(second.issue.sample.message).toBe("TypeError: x is not a function (v2)");
    expect(second.issue).toMatchObject({ firstSeen: 1_000, lastSeen: 9_000 });
});

/* Concurrency is the traffic this is BUILT for: a hundred browsers on one broken page in the same second. Two
 * unserialized read-modify-writes read the same count and write the same count+1, and a crash affecting a
 * thousand people reports as affecting three. */
test("simultaneous arrivals of one crash all count", async () => {
    const { store } = tempStore();
    const outcomes = await Promise.all(Array.from({ length: 25 }, (_unused, n) => store.record(arriving({ now: 1_000 + n }))));
    expect((await store.read("abc123"))?.count).toBe(25);
    // Exactly one of them opened the group, whichever won the race.
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

// An inbox is read newest-down, and for a group that started last week and is still happening, "newest" is when
// it last happened rather than when it began.
test("the list is ordered by when each group was last seen", async () => {
    const { store } = tempStore();
    await store.record(arriving({ id: "old", now: 1_000 }));
    await store.record(arriving({ id: "new", now: 5_000 }));
    await store.record(arriving({ id: "old", now: 9_000 }));
    expect((await store.list()).issues.map((issue) => issue.id)).toEqual(["old", "new"]);
});
