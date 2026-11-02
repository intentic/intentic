import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceTimersByTimeAsync, SETTLES, waitFor } from "@intentic/testing/bun";

// (2026-10-21) `setup` wakes the resident watcher once it has recorded a pairing, so the new session is made at once
// rather than at the next poll. On a throwaway home, since config.ts fixes its paths at import time.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "wake-"));
process.env["USERPROFILE"] = process.env["HOME"];
const { baseDir } = await import("../../config.js");
const { sleepUnlessWoken, wakeWatcher } = await import("../wake.js");
mkdirSync(baseDir, { recursive: true });

describe("the watcher's sleep between passes", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());
    it("ends as soon as another process wakes it", async () => {
        let ended = false;
        const sleeping = sleepUnlessWoken(10_000, new AbortController().signal).then(() => { ended = true; });
        await wakeWatcher();
        // The poll timer is frozen: only the file notification can end this wait.
        await waitFor(() => expect(ended).toBe(true), SETTLES);
        await sleeping;
    });

    it("runs its whole poll when nobody wakes it", async () => {
        let ended = false;
        const sleeping = sleepUnlessWoken(300, new AbortController().signal).then(() => { ended = true; });
        await advanceTimersByTimeAsync(299);
        expect(ended).toBe(false);
        await advanceTimersByTimeAsync(1);
        await sleeping;
        expect(ended).toBe(true);
    });

    it("rejects when its watcher is abandoned, as the plain sleep did", async () => {
        const abandoned = new AbortController();
        const sleeping = sleepUnlessWoken(10_000, abandoned.signal);
        abandoned.abort();
        await expect(sleeping).rejects.toThrow();
    });
});
