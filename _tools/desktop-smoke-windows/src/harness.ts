/* The assertion harness the three Windows tiers share — the direct counterpart of the `pass` / `fail` /
 * `until_true` trio at the top of `_tools/desktop-smoke/smoke.sh`, and deliberately the same shape, because the
 * two tiers assert the same journey on two operating systems and a reader should be able to hold one model.
 *
 * Three rules carried over from the Linux tier, each of which it learned the hard way:
 *
 *   • EVERY ASSERTION HAS ITS OWN DEADLINE. Nothing here is synchronous — an install, a window mapping, a link
 *     delivered through a second process. A fixed sleep is either flaky or slow, and on Windows it is both:
 *     a cold first launch of a WebView2 app is seconds slower than every launch after it.
 *   • A FAILURE DOES NOT STOP THE RUN. One tier reports every assertion it could make, because the second
 *     failure is usually what explains the first — "no window" plus "the process exited" is a crash, "no
 *     window" alone is a hang.
 *   • THE COUNT IS THE EXIT CODE'S ONLY INPUT. A tier ends by reporting, and reporting is the only thing that
 *     decides whether it passed. There is no `exit 1` scattered through the assertions.
 *
 * `sleep` is injected rather than imported so the polling loop can be tested without spending real seconds —
 * the deadline arithmetic is the part worth asserting, and it is exactly the part a real timer hides.
 */

export interface HarnessOptions {
    /** Where the transcript goes. Defaults to stdout/stderr. */
    readonly write?: (line: string) => void;
    readonly writeError?: (line: string) => void;
    /** Wall clock, in milliseconds. Injected for tests. */
    readonly now?: () => number;
    /** Injected for tests, where a poll must not cost a real second. */
    readonly sleep?: (ms: number) => Promise<void>;
}

export interface Harness {
    pass: (description: string) => void;
    fail: (description: string, detail?: string) => void;
    /** Prints a section heading — the `==> …` lines the Linux tier's log is read by. */
    section: (description: string) => void;
    /** Verbatim diagnostic output (a log tail, a command's stderr), indented under the last line. */
    detail: (text: string) => void;
    /**
     * Poll `predicate` until it answers true or the deadline passes, then record one assertion either way.
     * A predicate that throws counts as false — every probe here shells out, and "the command failed" and
     * "the command said no" are the same answer to the question being asked.
     */
    untilTrue: (seconds: number, description: string, predicate: () => boolean | Promise<boolean>) => Promise<boolean>;
    /** How many assertions have failed so far. */
    readonly failures: () => number;
    /** Print the verdict and answer the process exit code. */
    report: (what: string) => number;
}

const POLL_INTERVAL_MS = 500;

export const createHarness = (options: HarnessOptions = {}): Harness => {
    const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    const writeError = options.writeError ?? ((line) => process.stderr.write(`${line}\n`));
    const now = options.now ?? (() => Date.now());
    const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    let failures = 0;

    const pass = (description: string): void => write(`  ok   ${description}`);
    const fail = (description: string, detail?: string): void => {
        failures += 1;
        writeError(`  FAIL ${description}`);
        if (detail !== undefined && detail !== ``) {
            writeError(detail.replace(/^/gm, `       `));
        }
    };

    return {
        pass,
        fail,
        section: (description) => write(`\n==> ${description}`),
        detail: (text) => writeError(text.replace(/^/gm, `       `)),
        untilTrue: async (seconds, description, predicate) => {
            const deadline = now() + seconds * 1_000;
            for (;;) {
                let held = false;
                try {
                    held = await predicate();
                } catch {
                    held = false;
                }
                if (held) {
                    pass(description);
                    return true;
                }
                // Checked AFTER the probe, so a zero-second deadline still gets one attempt — the caller asked
                // for a fact, not for a delay.
                if (now() >= deadline) {
                    fail(`${description} (waited ${seconds}s)`);
                    return false;
                }
                await sleep(POLL_INTERVAL_MS);
            }
        },
        failures: () => failures,
        report: (what) => {
            if (failures > 0) {
                writeError(`\n==> ${what}: ${failures} failed assertion(s)`);
                return 1;
            }
            write(`\n==> ${what}`);
            return 0;
        },
    };
};
