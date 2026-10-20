import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForEnd, waitForLogMatch } from "./app-wait.js";

/* app_logs / app_status with waitFor or untilExit: the call answers on the event it waits for (a line landing in the
   log, the program's exit) rather than the agent calling again and again, and at its timeout at the latest (2026-10-20).
   Real files in a scratch folder, since what is being checked is that a write is heard. */

let dir = "";
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-wait-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const readIfThere = (path: string) => async (): Promise<string> => await readFile(path, "utf8").catch(() => "");

test("a line written after the wait began is heard as it lands, long before the timeout", async () => {
    const log = join(dir, "out.log");
    await writeFile(log, "starting\n");
    const started = Date.now();
    setTimeout(() => void appendFile(log, "Listening on :8080\n"), 100);
    const outcome = await waitForLogMatch({ path: log, pattern: /listening on/i, timeoutMs: 10_000, read: readIfThere(log) });
    expect(outcome).toBe("matched");
    // Well under the 2 s fallback re-read: the watch heard it.
    expect(Date.now() - started).toBeLessThan(1_500);
});

test("a log that does not exist yet is followed from the moment it appears", async () => {
    const log = join(dir, "later.log");
    setTimeout(() => void writeFile(log, "ready\n"), 100);
    expect(await waitForLogMatch({ path: log, pattern: /ready/, timeoutMs: 10_000, read: readIfThere(log) })).toBe("matched");
});

test("a line already there answers at once", async () => {
    const log = join(dir, "done.log");
    await writeFile(log, "ready\n");
    expect(await waitForLogMatch({ path: log, pattern: /ready/, timeoutMs: 10_000, read: readIfThere(log) })).toBe("matched");
});

test("a program that ends without the line ends the wait, after one last read for what it flushed on the way out", async () => {
    const log = join(dir, "crash.log");
    await writeFile(log, "");
    let exit = (): void => undefined;
    const ended = new Promise<void>((resolve) => {
        exit = resolve;
    });
    const waiting = waitForLogMatch({ path: log, pattern: /ready/, timeoutMs: 10_000, read: readIfThere(log), ended });
    setTimeout(exit, 50);
    expect(await waiting).toBe("ended");

    // The last read sees a line even when no watch event came for it.
    expect(await waitForLogMatch({ path: join(dir, "flushed.log"), pattern: /ready/, timeoutMs: 10_000, read: async () => "ready", ended: Promise.resolve() })).toBe("matched");
});

test("no match within the timeout says so", async () => {
    const log = join(dir, "quiet.log");
    await writeFile(log, "nothing\n");
    expect(await waitForLogMatch({ path: log, pattern: /ready/, timeoutMs: 150, read: readIfThere(log) })).toBe("timeout");
});

test("untilExit ends on the exit event, not a poll of the run", async () => {
    let looks = 0;
    let ended = false;
    let exit = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
        exit = resolve;
    });
    setTimeout(() => {
        ended = true;
        exit();
    }, 80);
    const started = Date.now();
    const gone = await waitForEnd({
        timeoutMs: 10_000,
        exit: exited,
        isEnded: async () => {
            looks += 1;
            return ended;
        },
    });
    expect(gone).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    // Once before (not ended yet) and once after the exit, to say how it stands: never on a timer.
    expect(looks).toBe(2);
});

test("a run with no exit to hear is looked at on the fallback timer, and the timeout still holds", async () => {
    let looks = 0;
    const gone = await waitForEnd({
        timeoutMs: 200,
        fallbackMs: 20,
        isEnded: async () => {
            looks += 1;
            return looks >= 4;
        },
    });
    expect(gone).toBe(true);
    expect(await waitForEnd({ timeoutMs: 60, fallbackMs: 20, isEnded: async () => false })).toBe(false);
});
