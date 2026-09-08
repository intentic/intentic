// Assertion harness shared by the three Windows tiers, mirroring the Linux tier's pass/fail/until_true rules:
// - every assertion has its own deadline, no fixed sleep
// - a failure doesn't stop the run: a second failure often explains the first
// - the failure count is the only input to the exit code

export interface HarnessOptions {
    /** Where the transcript goes; defaults to stdout/stderr. */
    readonly write?: (line: string) => void;
    readonly writeError?: (line: string) => void;
    /** Wall clock in milliseconds; injected for tests. */
    readonly now?: () => number;
    /** Injected for tests, so a poll doesn't cost a real second. */
    readonly sleep?: (ms: number) => Promise<void>;
}

export interface Harness {
    pass: (description: string) => void;
    fail: (description: string, detail?: string) => void;
    /** Prints a section heading, the `==> …` lines the Linux tier's log is read by. */
    section: (description: string) => void;
    /** Verbatim diagnostic output (a log tail, a command's stderr), indented under the last line. */
    detail: (text: string) => void;
    /**
     * Polls `predicate` until it answers true or the deadline passes, then records one assertion either way. A
     * predicate that throws counts as false: a failed command and a command that said no are the same answer here.
     */
    untilTrue: (seconds: number, description: string, predicate: () => boolean | Promise<boolean>) => Promise<boolean>;
    /** How many assertions have failed so far. */
    readonly failures: () => number;
    /** Prints the verdict and returns the process exit code. */
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
                // Checked after the probe, so a zero-second deadline still gets one attempt.
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
