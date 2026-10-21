import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// (2026-10-21) `setup` wakes the resident watcher once it has recorded a pairing, so the new session is made at once
// rather than at the next poll. On a throwaway home, since config.ts fixes its paths at import time.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "wake-"));
process.env["USERPROFILE"] = process.env["HOME"];
const { baseDir } = await import("../../config.js");
const { sleepUnlessWoken, wakeWatcher } = await import("../wake.js");
mkdirSync(baseDir, { recursive: true });

describe("the watcher's sleep between passes", () => {
    it("ends as soon as another process wakes it", async () => {
        const started = Date.now();
        const sleeping = sleepUnlessWoken(10_000, new AbortController().signal);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await wakeWatcher();
        await sleeping;
        expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("runs its whole poll when nobody wakes it", async () => {
        const started = Date.now();
        await sleepUnlessWoken(300, new AbortController().signal);
        expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    });

    it("rejects when its watcher is abandoned, as the plain sleep did", async () => {
        const abandoned = new AbortController();
        const sleeping = sleepUnlessWoken(10_000, abandoned.signal);
        abandoned.abort();
        await expect(sleeping).rejects.toThrow();
    });
});
