import { createDownloadTracker, DOWNLOAD_POLICY, type DownloadRecord, expiredDownloads, wireDownload } from "./download-tracker.js";

/* A profile's download list and the policy that keeps it bounded: what goes by age, by count and by bytes, that one
   still arriving never goes, and how often its windows are told while bytes arrive. */

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const record = (id: string, change: Partial<DownloadRecord> = {}): DownloadRecord => ({
    id,
    profile: "_own",
    name: `${id}.bin`,
    url: `https://example.com/${id}`,
    state: "done",
    receivedBytes: 100,
    totalBytes: 100,
    startedAt: NOW - HOUR,
    finishedAt: NOW - HOUR,
    file: `/downloads/${id}/${id}.bin`,
    ...change,
});

describe("the download policy", () => {
    const policy = { maxAgeMs: 10 * HOUR, maxBytes: 1000, maxCount: 3 };

    test("a finished download older than the age goes, one exactly at it stays", () => {
        const atAge = record("at", { finishedAt: NOW - 10 * HOUR });
        const past = record("past", { finishedAt: NOW - 10 * HOUR - 1 });
        expect(expiredDownloads([atAge, past], NOW, policy).map((one) => one.id)).toEqual(["past"]);
    });

    test("past the count, the oldest go first", () => {
        const list = ["a", "b", "c", "d", "e"].map((id, at) => record(id, { finishedAt: NOW - at * HOUR }));
        expect(expiredDownloads(list, NOW, policy).map((one) => one.id)).toEqual(["d", "e"]);
    });

    test("past the bytes, the oldest go until the rest fit", () => {
        const list = [record("new", { receivedBytes: 600, finishedAt: NOW }), record("mid", { receivedBytes: 400, finishedAt: NOW - HOUR }), record("old", { receivedBytes: 1, finishedAt: NOW - 2 * HOUR })];
        // 600 + 400 is exactly the cap; the next byte is past it.
        expect(expiredDownloads(list, NOW, policy).map((one) => one.id)).toEqual(["old"]);
    });

    test("a download still arriving is never taken, and its bytes do not count", () => {
        const arriving = record("arriving", { state: "progress", receivedBytes: 5000, finishedAt: undefined, startedAt: NOW - 100 * HOUR });
        const kept = record("kept", { receivedBytes: 900 });
        expect(expiredDownloads([arriving, kept], NOW, policy)).toEqual([]);
    });

    test("a failed or canceled one counts against the number but holds no bytes", () => {
        const list = [
            record("failed", { state: "failed", receivedBytes: 999, finishedAt: NOW }),
            record("canceled", { state: "canceled", receivedBytes: 999, finishedAt: NOW - 1 }),
            record("done", { receivedBytes: 1000, finishedAt: NOW - 2 }),
            record("fourth", { receivedBytes: 1, finishedAt: NOW - 3 }),
        ];
        expect(expiredDownloads(list, NOW, policy).map((one) => one.id)).toEqual(["fourth"]);
    });

    test("the shipped policy keeps a week, 2 GiB and 100 files", () => {
        expect(DOWNLOAD_POLICY).toEqual({ maxAgeMs: 7 * 24 * HOUR, maxBytes: 2 * 1024 ** 3, maxCount: 100 });
    });
});

describe("the download list", () => {
    test("lists newest first, one profile's or everyone's", () => {
        const tracker = createDownloadTracker(() => undefined);
        tracker.add(record("older", { startedAt: NOW - 2 * HOUR }));
        tracker.add(record("newer", { startedAt: NOW - HOUR }));
        tracker.add(record("theirs", { profile: "acme", startedAt: NOW }));
        expect(tracker.list("_own").map((one) => one.id)).toEqual(["newer", "older"]);
        expect(tracker.list().map((one) => one.id)).toEqual(["theirs", "newer", "older"]);
    });

    test("a new download, a finish and a removal are told at once; progress at most once per window", () => {
        jest.useFakeTimers();
        try {
            const told: string[] = [];
            const tracker = createDownloadTracker((profile) => told.push(profile), 250);
            tracker.add(record("big", { state: "progress", receivedBytes: 0 }));
            expect(told).toEqual(["_own"]);
            for (let step = 1; step <= 10; step += 1) {
                tracker.update("big", (entry) => {
                    entry.receivedBytes = step * 10;
                });
            }
            // Ten progress events inside the window since the add: none told yet, one queued.
            expect(told).toEqual(["_own"]);
            jest.advanceTimersByTime(250);
            expect(told).toEqual(["_own", "_own"]);
            tracker.update("big", (entry) => {
                entry.state = "done";
            });
            expect(told).toEqual(["_own", "_own", "_own"]);
            tracker.remove("big");
            expect(told).toHaveLength(4);
            expect(tracker.get("big")).toBeUndefined();
        } finally {
            jest.useRealTimers();
        }
    });

    test("the wire leaves out what is not known yet", () => {
        expect(wireDownload(record("arriving", { state: "progress", totalBytes: undefined, finishedAt: undefined }))).toEqual({
            id: "arriving",
            name: "arriving.bin",
            url: "https://example.com/arriving",
            state: "progress",
            receivedBytes: 100,
            startedAt: NOW - HOUR,
        });
    });
});
