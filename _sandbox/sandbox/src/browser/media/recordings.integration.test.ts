import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { CastControl } from "./castd-control.js";
import { pruneTurnRecordings, releaseWindowRecording, type Running, startRecording, startWindowRecording, stopRecording, sweepStaged } from "./recordings.js";

// Recordings as files: castd writes one where it is told and answers where at the stop, a window holds one at a time
// however many ask, and an agent's turn recordings age out a week and 2 GiB on, oldest first.

const DAY = 24 * 3_600_000;
const NOW = Date.UTC(2027, 0, 15, 8);

let dir = "";
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "recordings-"));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

// A file of `bytes` (sparse: only its length matters) last written `age` ago.
const file = (path: string, bytes: number, age: number): void => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
    truncateSync(path, bytes);
    const at = new Date(NOW - age);
    utimesSync(path, at, at);
};

describe("pruneTurnRecordings", () => {
    test("removes parts past a week, then the oldest past the bytes, and nothing that is not a turn's part", async () => {
        file(join(dir, "conv-a", "web-2027-01-01T08-00-00.mp4"), 10, 14 * DAY);
        file(join(dir, "conv-a", "web-2027-01-14T08-00-00.mp4"), 60, 1 * DAY);
        file(join(dir, "conv-b", "agent@example.com-2027-01-15T07-00-00-2.mp4"), 50, 3_600_000);
        file(join(dir, "conv-b", "agent@example.com-2027-01-15T06-00-00.mp4"), 30, 2 * 3_600_000);
        // Not a turn's part: a screenshot, an MP4 someone else put there, and the folder's own top level.
        file(join(dir, "conv-b", "notes.mp4"), 10_000, 30 * DAY);
        file(join(dir, "conv-b", "page-2027-01-01.png"), 10_000, 30 * DAY);
        file(join(dir, "web-2027-01-01T08-00-00.mp4"), 10_000, 30 * DAY);
        const removed = await pruneTurnRecordings(dir, NOW, { maxAgeMs: 7 * DAY, maxBytes: 100 });
        // Newest first: 50 kept, 30 kept (80), 60 would pass 100 and goes, the 14-day-old one is past its age.
        expect(removed.toSorted()).toEqual(["web-2027-01-01T08-00-00.mp4", "web-2027-01-14T08-00-00.mp4"]);
        expect(readdirSync(join(dir, "conv-a"))).toEqual([]);
        expect(readdirSync(join(dir, "conv-b")).toSorted()).toEqual(
            ["agent@example.com-2027-01-15T06-00-00.mp4", "agent@example.com-2027-01-15T07-00-00-2.mp4", "notes.mp4", "page-2027-01-01.png"].toSorted(),
        );
        expect(existsSync(join(dir, "web-2027-01-01T08-00-00.mp4"))).toBe(true);
    });

    test("an artifacts folder that does not exist yet holds nothing to remove", async () => {
        expect(await pruneTurnRecordings(join(dir, "none"), NOW)).toEqual([]);
    });
});

describe("a recording as castd writes it", () => {
    test("is started on a fresh file in castd's directory, and its stop answers that file and no other", async () => {
        const started: string[] = [];
        let answered = "";
        const control = unstubbed<CastControl>("control", {
            recordStart: async (name) => {
                started.push(name);
                return { id: 7, max_seconds: 300 };
            },
            recordStop: async () => ({ file: answered, bytes: 2048 }),
        });
        const running = await startRecording({ control }, NOW, dir);
        expect(started[0]).toMatch(/^rec-[0-9a-f-]{36}\.mp4$/u);
        expect(running?.file).toBe(join(dir, started[0] ?? ""));
        answered = running?.file ?? "";
        expect(await stopRecording(running!)).toEqual({ file: answered, bytes: 2048 });
        // castd naming a file it was not told to write is no recording of this daemon's.
        answered = "/etc/passwd";
        expect(await stopRecording(running!)).toBeUndefined();
    });

    test("a staged file nobody came for is swept once castd could no longer be writing it; anything else stays", async () => {
        const stale = join(dir, "rec-00000000-0000-4000-8000-000000000000.mp4");
        const young = join(dir, "rec-11111111-1111-4111-8111-111111111111.mp4");
        const other = join(dir, "keep.mp4");
        file(stale, 1, 3 * 3_600_000);
        file(young, 1, 60_000);
        file(other, 1, 30 * DAY);
        await sweepStaged(dir, NOW);
        expect([existsSync(stale), existsSync(young), existsSync(other)]).toEqual([false, true, true]);
    });
});

describe("one recording per window", () => {
    test("a second start while the first waits on castd answers the first, and castd is asked once", async () => {
        let starts = 0;
        let resolveStart: (running: Running) => void = () => undefined;
        const start = (): Promise<Running | undefined> => {
            starts += 1;
            return new Promise((resolve) => {
                resolveStart = resolve;
            });
        };
        const first = startWindowRecording("w-twice", start, () => undefined);
        const second = startWindowRecording("w-twice", start, () => undefined);
        resolveStart({ castd: unstubbed("castd", {}), id: 1, startedAt: NOW, maxSeconds: 300, file: join(dir, "a.mp4") });
        expect(await first).toEqual({ startedAt: NOW, maxSeconds: 300 });
        expect(await second).toEqual({ startedAt: NOW, maxSeconds: 300 });
        // Under way now: a third ask answers it too.
        expect(await startWindowRecording("w-twice", start, () => undefined)).toEqual({ startedAt: NOW, maxSeconds: 300 });
        expect(starts).toBe(1);
        expect(releaseWindowRecording("w-twice")?.id).toBe(1);
    });
});
