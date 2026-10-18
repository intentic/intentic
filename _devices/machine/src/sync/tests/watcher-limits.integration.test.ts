import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Pairing } from "../config.js";
import { diskFloor, FLOOR_MAX_BYTES, FLOOR_MIN_BYTES, lowDiskStep, readDisk, RESUME_MARGIN_BYTES, writesToDisk } from "../low-disk.js";
import { runWatched } from "../exec.js";

// The two limits the watcher keeps on what it may spend on this computer: a command that may run as long as it keeps
// moving (exec.ts `runWatched`, which the git bridge's fetch runs under), and the floor kept free on the drive a synced
// folder is on (low-disk.ts).

// A JavaScript one-liner run by this very runtime, so the test needs nothing installed.
const script = (source: string): [string, string[]] => [process.execPath, ["-e", source]];

describe("runWatched", () => {
    it("lets a command that ends by itself end, with its output", async () => {
        const [command, args] = script("console.log('done')");
        const result = await runWatched(command, args, { quietMs: 5_000, ceilingMs: 20_000 });
        expect(result.ending).toBe("exited");
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe("done");
    });

    it("stops a command that goes quiet past its allowance", async () => {
        const [command, args] = script("console.log('started'); setTimeout(() => {}, 30000)");
        const started = Date.now();
        const result = await runWatched(command, args, { quietMs: 400, ceilingMs: 20_000 });
        expect(result.ending).toBe("stalled");
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("lets a command that keeps talking run past the quiet allowance, up to its ceiling", async () => {
        const [command, args] = script("setInterval(() => console.log('.'), 50)");
        const result = await runWatched(command, args, { quietMs: 400, ceilingMs: 1_500 });
        expect(result.ending).toBe("ceiling");
        expect(result.stdout.length).toBeGreaterThan(10);
    });

    it("stops when the caller's signal says so, and calls that its own ending", async () => {
        const [command, args] = script("setInterval(() => console.log('.'), 50)");
        const stop = new AbortController();
        setTimeout(() => stop.abort(), 300);
        const result = await runWatched(command, args, { quietMs: 5_000, ceilingMs: 20_000, signal: stop.signal });
        expect(result.ending).toBe("stopped");
    });
});

const GIB = 1024 ** 3;

describe("diskFloor", () => {
    it("is 2% of the drive, never under 5 GiB and never over 20 GiB", () => {
        expect(diskFloor(100 * GIB)).toBe(FLOOR_MIN_BYTES);
        expect(diskFloor(500 * GIB)).toBe(10 * GIB);
        expect(diskFloor(953 * GIB)).toBeCloseTo(19.06 * GIB, -6);
        expect(diskFloor(4096 * GIB)).toBe(FLOOR_MAX_BYTES);
    });
});

describe("lowDiskStep", () => {
    const total = 500 * GIB; // floor 10 GiB
    it("pauses a pairing under the floor and leaves one above it alone", () => {
        expect(lowDiskStep({ freeBytes: 9 * GIB, totalBytes: total }, false)).toBe("pause");
        expect(lowDiskStep({ freeBytes: 11 * GIB, totalBytes: total }, false)).toBe("none");
    });

    it("resumes only once the floor and its margin are free, so freeing a little does not start it all again", () => {
        expect(lowDiskStep({ freeBytes: 11 * GIB, totalBytes: total }, true)).toBe("hold");
        expect(lowDiskStep({ freeBytes: 10 * GIB + RESUME_MARGIN_BYTES, totalBytes: total }, true)).toBe("resume");
    });

    it("never pauses or lifts on a drive it could not measure", () => {
        expect(lowDiskStep(undefined, false)).toBe("none");
        expect(lowDiskStep(undefined, true)).toBe("hold");
    });
});

describe("writesToDisk", () => {
    const base: Pairing = { sandboxUrl: "https://s.example.dev", sandboxId: "s", mode: "sync", localDir: "/home/me/intentic/s" };
    it("guards a workspace folder and a two-way project, never a copy-first project, the projects host or a mirror", () => {
        expect(writesToDisk(base)).toBe(true);
        expect(writesToDisk({ ...base, project: true, remoteDir: "/work/app", direction: "both" })).toBe(true);
        expect(writesToDisk({ ...base, project: true, remoteDir: "/work/app" })).toBe(false);
        expect(writesToDisk({ ...base, projectsHost: true })).toBe(false);
        expect(writesToDisk({ ...base, mode: "mirror" })).toBe(false);
    });
});

describe("readDisk", () => {
    it("measures a folder not made yet on the drive of its nearest parent that exists", async () => {
        const dir = await mkdtemp(join(tmpdir(), "low-disk-"));
        try {
            const reading = await readDisk(join(dir, "not", "made", "yet"));
            expect(reading?.totalBytes).toBeGreaterThan(0);
            expect(reading?.freeBytes).toBeGreaterThanOrEqual(0);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
