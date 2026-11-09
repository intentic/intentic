import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceTimersByTimeAsync, realYield, SETTLES, waitFor } from "@intentic/testing/bun";
import { LOG_FALLBACK_MS, waitForEnd, waitForLogMatch } from "./app-wait.js";

/* app_logs / app_status with waitFor or untilExit: the call answers on the event it waits for (a line landing in the
   log, the program's exit) rather than the agent calling again and again, and at its timeout at the latest (2026-10-20).
   Real files in a scratch folder, since what is being checked is that a write is heard. */

let dir = "";
beforeEach(async () => {
    jest.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), "app-wait-"));
});
afterEach(async () => {
    jest.useRealTimers();
    await rm(dir, { recursive: true, force: true });
});

const readIfThere = (path: string) => async (): Promise<string> => await readFile(path, "utf8").catch(() => "");

test("a line written after the wait began is heard as it lands, long before the timeout", async () => {
    const log = join(dir, "out.log");
    await writeFile(log, "starting\n");
    const initialRead = Promise.withResolvers<void>();
    let outcome: string | undefined;
    const waiting = waitForLogMatch({
        path: log, pattern: /listening on/i, timeoutMs: 10_000,
        read: async () => {
            const text = await readIfThere(log)();
            initialRead.resolve();
            return text;
        },
    }).then((result) => { outcome = result; });
    await initialRead.promise;
    await appendFile(log, "Listening on :8080\n");
    // The fallback and timeout clocks are frozen: only the file event can finish this read.
    await waitFor(() => expect(outcome).toBe("matched"), SETTLES);
    await waiting;
});

test("a log that does not exist yet is followed from the moment it appears", async () => {
    const log = join(dir, "later.log");
    let outcome: string | undefined;
    const waiting = waitForLogMatch({ path: log, pattern: /ready/, timeoutMs: 10_000, read: readIfThere(log) }).then((result) => { outcome = result; });
    await writeFile(log, "ready\n");
    await waitFor(() => expect(outcome).toBe("matched"), SETTLES);
    await waiting;
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
    exit();
    expect(await waiting).toBe("ended");

    // The last read sees a line even when no watch event came for it.
    expect(await waitForLogMatch({ path: join(dir, "flushed.log"), pattern: /ready/, timeoutMs: 10_000, read: async () => "ready", ended: Promise.resolve() })).toBe("matched");
});

test("no match within the timeout says so", async () => {
    const log = join(dir, "quiet.log");
    await writeFile(log, "nothing\n");
    const waiting = waitForLogMatch({ path: log, pattern: /ready/, timeoutMs: 150, read: readIfThere(log) });
    await advanceTimersByTimeAsync(150);
    expect(await waiting).toBe("timeout");
});

test("the final read waits for a read already in flight before looking for flushed output", async () => {
    const first = Promise.withResolvers<string>();
    const exited = Promise.withResolvers<void>();
    let reads = 0;
    let active = 0;
    let peak = 0;
    const waiting = waitForLogMatch({
        path: join(dir, "serial.log"), pattern: /ready/, timeoutMs: 10_000, ended: exited.promise,
        read: async () => {
            reads += 1;
            active += 1;
            peak = Math.max(peak, active);
            try {
                return reads === 1 ? await first.promise : "ready";
            } finally {
                active -= 1;
            }
        },
    });
    exited.resolve();
    await realYield();
    first.resolve("");
    expect(await waiting).toBe("matched");
    expect(reads).toBe(2);
    expect(peak).toBe(1);
});

test("a timed-out read cannot run a queued fallback or a late exit read", async () => {
    const first = Promise.withResolvers<string>();
    const exited = Promise.withResolvers<void>();
    const read = jest.fn(async () => await first.promise);
    const waiting = waitForLogMatch({
        path: join(dir, "timeout.log"), pattern: /ready/, timeoutMs: LOG_FALLBACK_MS + 100, read, ended: exited.promise,
    });
    await advanceTimersByTimeAsync(LOG_FALLBACK_MS + 100);
    expect(await waiting).toBe("timeout");
    first.resolve("");
    exited.resolve();
    await realYield();
    expect(read).toHaveBeenCalledTimes(1);
});

test("untilExit ends on the exit event, not a poll of the run", async () => {
    let looks = 0;
    let ended = false;
    let exit = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
        exit = resolve;
    });
    const waiting = waitForEnd({
        timeoutMs: 10_000,
        exit: exited,
        isEnded: async () => {
            looks += 1;
            return ended;
        },
    });
    await realYield();
    expect(looks).toBe(1);
    ended = true;
    exit();
    expect(await waiting).toBe(true);
    // Once before (not ended yet) and once after the exit, to say how it stands: never on a timer.
    expect(looks).toBe(2);
});

test("a run with no exit to hear is looked at on the fallback timer, and the timeout still holds", async () => {
    let looks = 0;
    const waiting = waitForEnd({
        timeoutMs: 200,
        fallbackMs: 20,
        isEnded: async () => {
            looks += 1;
            return looks >= 4;
        },
    });
    await advanceTimersByTimeAsync(60);
    expect(await waiting).toBe(true);
    expect(looks).toBe(5);
    const expiring = waitForEnd({ timeoutMs: 60, fallbackMs: 20, isEnded: async () => false });
    await advanceTimersByTimeAsync(60);
    expect(await expiring).toBe(false);
});
