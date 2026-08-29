import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { watchPromptSignals } from "./prompt-signal.js";

// What the image's zsh hook does on every prompt: `: >| .../prompt`, which creates the file the first time and
// truncates it in place after that. Both are what the watcher has to notice.
const touch = (dir: string): void => writeFileSync(join(dir, "prompt"), "");

test("a shell reaching its prompt wakes the feed, first prompt and every one after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-signal-"));
    let signals = 0;
    const stop = watchPromptSignals(() => {
        signals += 1;
    }, dir);

    touch(dir);
    await vi.waitFor(() => expect(signals).toBeGreaterThan(0));
    const created = signals;
    touch(dir);
    await vi.waitFor(() => expect(signals).toBeGreaterThan(created));
    stop();
});

// The last browser disconnecting takes the watch with it, on the same terms as the sampler: nobody to be stale.
test("a stopped watch is silent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-signal-"));
    let signals = 0;
    const stop = watchPromptSignals(() => {
        signals += 1;
    }, dir);
    stop();

    touch(dir);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signals).toBe(0);
});

// A box with no /run to write in (the tests themselves, a stripped image) loses the instant half and keeps the
// sampler. It must not lose the daemon.
test("a directory that cannot be created is silence, never a throw", () => {
    const stop = watchPromptSignals(() => {
        throw new Error("must not be called");
    }, "/proc/self/status/not-a-directory");
    expect(() => stop()).not.toThrow();
});
