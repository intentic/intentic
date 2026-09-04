import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

/* WHAT bin/queue-run PROMISES, checked against real processes and a real kernel lock.
 *
 * The policy half (which commands are heavy) is a pure function with its own unit tests; this file is about
 * the half that cannot be faked, because the whole reason the slot is an `flock` on an inherited descriptor
 * rather than a counter in the daemon is what happens to processes that DON'T exit politely. A killed command,
 * a command whose parent is gone, a daemon restarted underneath a running suite: each of those releases its
 * slot only if the kernel is the thing releasing it, and only a real process can show that.
 *
 * Timings are deliberately coarse (a 300ms body against a 1s poll) so a loaded runner cannot fail this on
 * latency: every assertion is about ORDER and COUNT, never about how long something took. Where a test needs
 * two bodies to be running AT ONCE, they rendezvous through the log rather than through a sleep — see `body`. */

const QUEUE_RUN = join(import.meta.dirname, "../../bin/queue-run");

interface Run {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

// `bash <path>`, not the path itself: the file is mode 644 in git and only becomes executable when the
// Dockerfile copies it with --chmod=755, so running it directly would pass or fail on a checkout's file mode.
const queueRun = (dir: string, args: readonly string[], command: string, pathPrefix?: string): Promise<Run> =>
    new Promise((resolve) => {
        const child = spawn("bash", [QUEUE_RUN, ...args, "--", "bash", "-c", command], {
            env: {
                ...process.env,
                INTENTIC_QUEUE_DIR: dir,
                INTENTIC_QUEUE_POLL: "1",
                ...(pathPrefix === undefined ? {} : { PATH: `${pathPrefix}:${process.env["PATH"] ?? ""}` }),
            },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

const dir = async (): Promise<string> => mkdtemp(join(tmpdir(), "queue-run-"));

/* The peak number of bodies running at once, replayed from a log each body brackets itself in. `>>` of one
 * short line is a single atomic append on Linux, which is what makes this readable after the fact rather than
 * needing the test to watch live. */
const peakConcurrency = async (log: string): Promise<number> => {
    const marks = (await readFile(log, "utf8")).split("\n").filter((line) => line === "+" || line === "-");
    let running = 0;
    let peak = 0;
    for (const mark of marks) {
        running += mark === "+" ? 1 : -1;
        peak = Math.max(peak, running);
    }
    return peak;
};

/* A body that brackets itself in the log, and — where the test is about bodies overlapping — WAITS INSIDE THE
 * BRACKET until `together` of them have started.
 *
 * That wait is what makes the peak a fact about the queue instead of a fact about the runner. With a plain
 * sleep, two bodies overlap only if the second process reaches its first line before the first one's sleep is
 * over, so "these two ran at once" is really an assertion that a fork+exec beat 300ms — the latency assertion
 * this file's header says it does not make. Measured on this box: two children of the same Promise.all start
 * within 9ms of each other on an idle machine, 84ms at load 69, and 313ms at load 180 — past the body, at which
 * point the marks read +,-,+,- and the peak is 1 with nothing whatsoever contended. That is the shape that
 * failed on CI, where this suite runs beside 490-odd other files.
 *
 * The wait is bounded, so it weakens nothing: a body kept out by a slot that should not have held it waits out
 * the bound, leaves alone, and the peak stays at 1 — the failure the test is there to report. The `sleep` after
 * the rendezvous is the other half, the window in which a limit that is NOT enforced shows up as a peak above
 * what was asked for.
 *
 * THE BOUND IS THIRTY SECONDS AND NOT FIVE, which is the whole of one CI failure. `separate pools do not
 * contend` reported a peak of 1 on a green tree: both bodies were admitted, as the queue promises, but the
 * second process did not reach its first line inside the old five-second bound, so the first gave up waiting
 * for it and the marks read +,-,+,-. That is the bound being an assertion about how fast a loaded runner forks,
 * which is the one assertion this file's header says it does not make. Raising it costs nothing on a machine
 * that is not loaded — the loop breaks on the count, not on the clock, so the fast path is unchanged — and the
 * only thing a longer bound can do to a REAL failure is make the suite take half a minute to report it. */
const RENDEZVOUS_SECONDS = 30;
const POLL_SECONDS = 0.05;
const body = (log: string, { together = 1, ms = 300 }: { together?: number; ms?: number } = {}): string =>
    `echo + >> ${log}; ` +
    `for _ in $(seq 1 ${Math.round(RENDEZVOUS_SECONDS / POLL_SECONDS)}); do [ "$(grep -c '^+$' ${log})" -ge ${together} ] && break; sleep ${POLL_SECONDS}; done; ` +
    `sleep ${ms / 1000}; echo - >> ${log}`;

/* A process that HOLDS the pool's only slot, which does not return until it demonstrably does.
 *
 * The three tests below need a slot already taken before they ask for it, and each used to spawn a holder and
 * sleep 400ms. That sleep is a guess about how long bash takes to start and `flock` to be granted, and on a
 * loaded runner it is the wrong guess: `runs anyway once the deadline passes` failed on CI with an EMPTY
 * stderr, which is what the waiter prints when it never had to wait — the holder had not taken the slot yet, so
 * the waiter walked straight in and the test asked a question about waiting that nothing had answered.
 *
 * The marker is written by the held COMMAND, so it appears only after queue-run has the lock and exec'd: there
 * is no window in which the file exists and the slot is not held. Bounded, and a bound that expires is an
 * explicit failure rather than a confusing assertion further down. */
const holdSlot = async (queue: string, args: readonly string[], seconds: number): Promise<ChildProcess> => {
    const held = join(queue, "held");
    const child = spawn("bash", [QUEUE_RUN, ...args, "--", "bash", "-c", `echo held > ${held}; sleep ${seconds}`], {
        env: { ...process.env, INTENTIC_QUEUE_DIR: queue, INTENTIC_QUEUE_POLL: "1" },
    });
    const deadline = Date.now() + RENDEZVOUS_SECONDS * 1000;
    while (Date.now() < deadline) {
        try {
            await readFile(held, "utf8");
            return child;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
        }
    }
    child.kill("SIGKILL");
    throw new Error(`the holder never took the slot in ${RENDEZVOUS_SECONDS}s, so nothing below is testing what it says`);
};

test("runs the command, passing through its output and its real exit code", async () => {
    const run = await queueRun(await dir(), ["--pool", "p", "--limit", "2"], "echo hello; exit 7");
    expect(run.stdout.trim()).toBe("hello");
    expect(run.code).toBe(7);
});

test("holds the pool to its limit, and every queued command still runs", async () => {
    const queue = await dir();
    const log = join(queue, "marks");
    // Five at once against two slots: the assertion that matters is that the sixth thing the box is asked to
    // do never becomes the third thing it is doing — and that two of them DO get to run together, which is the
    // half a limit of one would also satisfy.
    const runs = await Promise.all(
        Array.from({ length: 5 }, () => queueRun(queue, ["--pool", "p", "--limit", "2"], body(log, { together: 2 }))),
    );
    expect(runs.every((run) => run.code === 0)).toBe(true);
    expect(await peakConcurrency(log)).toBe(2);
});

test("a limit of one serialises completely", async () => {
    const queue = await dir();
    const log = join(queue, "marks");
    const runs = await Promise.all(Array.from({ length: 3 }, () => queueRun(queue, ["--pool", "p", "--limit", "1"], body(log))));
    expect(runs.every((run) => run.code === 0)).toBe(true);
    expect(await peakConcurrency(log)).toBe(1);
});

test("separate pools do not contend", async () => {
    const queue = await dir();
    const log = join(queue, "marks");
    // Two pools of one each must overlap; if they did not, the pool name would be decoration and a workspace
    // could not give its type checks a budget separate from its tests.
    const runs = await Promise.all([
        queueRun(queue, ["--pool", "a", "--limit", "1"], body(log, { together: 2 })),
        queueRun(queue, ["--pool", "b", "--limit", "1"], body(log, { together: 2 })),
    ]);
    expect(runs.every((run) => run.code === 0)).toBe(true);
    expect(await peakConcurrency(log)).toBe(2);
});

test("a command that fails still frees its slot", async () => {
    const queue = await dir();
    const log = join(queue, "marks");
    const runs = await Promise.all([
        queueRun(queue, ["--pool", "p", "--limit", "1"], `echo + >> ${log}; sleep 0.3; echo - >> ${log}; exit 3`),
        queueRun(queue, ["--pool", "p", "--limit", "1"], body(log)),
    ]);
    expect(runs.map((run) => run.code).toSorted()).toEqual([0, 3]);
    expect(await peakConcurrency(log)).toBe(1);
});

test("a KILLED command frees its slot, which is the case a lease would get wrong", async () => {
    const queue = await dir();
    /* The reason the slot is a kernel lock. A daemon-side counter releases on a callback the killed process
     * never reaches, so this slot would stay held until some TTL expired — and the sandbox would be one slot
     * poorer for every command anyone ever interrupted. */
    const killed = await holdSlot(queue, ["--pool", "p", "--limit", "1"], 30);
    killed.kill("SIGKILL");
    await new Promise((resolve) => killed.on("close", resolve));

    const after = await queueRun(queue, ["--pool", "p", "--limit", "1", "--wait", "5"], "echo free");
    expect(after.stdout.trim()).toBe("free");
    // It got the slot rather than timing out into it: the deadline notice is what a leaked slot would print.
    expect(after.stderr).not.toContain("starting anyway");
});

test("runs anyway once the deadline passes, rather than blocking forever", async () => {
    const queue = await dir();
    const holder = await holdSlot(queue, ["--pool", "p", "--limit", "1"], 10);
    try {
        /* A queue that can block forever turns one stuck suite into a dead sandbox. The command runs, says in
         * the pane that it gave up waiting, and the exit code is still the command's own. */
        const waited = await queueRun(queue, ["--pool", "p", "--limit", "1", "--wait", "2"], "echo ran; exit 4");
        expect(waited.stdout.trim()).toBe("ran");
        expect(waited.code).toBe(4);
        expect(waited.stderr).toContain('pool "p"');
        expect(waited.stderr).toMatch(/starting anyway|slot free after/);
    } finally {
        holder.kill("SIGKILL");
    }
});

test("says in the pane that it is waiting, then that it started", async () => {
    const queue = await dir();
    // Long enough that the holder is still in the slot when the second command asks for it and polls once at
    // INTENTIC_QUEUE_POLL=1, and short enough that the test waits that out rather than the full deadline: the
    // old 1.5s was measured against a 400ms sleep, and once the wait became a rendezvous it had no margin left.
    const holder = await holdSlot(queue, ["--pool", "p", "--limit", "1", "--label", "vitest"], 5);
    // The person watching a pane where nothing is happening is owed a reason; silence here reads as a hang.
    const second = await queueRun(queue, ["--pool", "p", "--limit", "1", "--wait", "30", "--label", "vitest"], "echo second");
    expect(second.stderr).toContain('pool "p"');
    expect(second.stderr).toContain("vitest");
    expect(second.stderr).toMatch(/waiting|slot free after/);
    expect(second.stdout.trim()).toBe("second");
    holder.kill("SIGKILL");
});

/* FAIL OPEN, the property that decides whether this wrapper is safe to put in front of every heavy command an
 * agent runs. None of these inputs is one the daemon should produce; all of them must still run the command. */
test.each([
    ["a bad limit", ["--pool", "p", "--limit", "not-a-number"]],
    ["a bad deadline", ["--pool", "p", "--limit", "1", "--wait", "abc"]],
    ["an unknown flag from a newer daemon", ["--pool", "p", "--limit", "1", "--future-flag", "x"]],
    ["no flags at all", []],
])("runs the command despite %s", async (_name, args) => {
    const run = await queueRun(await dir(), args, "echo survived");
    expect(run.stdout.trim()).toBe("survived");
    expect(run.code).toBe(0);
});

test("an empty command line is not an error", async () => {
    const queue = await dir();
    const run = await new Promise<Run>((resolve) => {
        const child = spawn("bash", [QUEUE_RUN, "--pool", "p", "--limit", "1", "--"], {
            env: { ...process.env, INTENTIC_QUEUE_DIR: queue },
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("close", (code) => resolve({ code, stdout: "", stderr }));
    });
    expect(run.code).toBe(0);
});

test("the slot survives exec, so the lock covers the command and not the wrapper", async () => {
    const queue = await dir();
    /* The bug this pins: bash marks `{var}>`-allocated descriptors close-on-exec, so an implementation using
     * that form drops the lock at the exec and every command runs holding nothing — a queue that reports
     * success while enforcing no limit at all. A limit of one with a body long enough to overlap is the
     * cheapest way to notice. */
    const log = join(queue, "marks");
    const runs = await Promise.all(Array.from({ length: 4 }, () => queueRun(queue, ["--pool", "p", "--limit", "1"], body(log, { ms: 400 }))));
    expect(runs.every((run) => run.code === 0)).toBe(true);
    expect(await peakConcurrency(log)).toBe(1);
});

/* THE MEMORY HALF OF THE GATE (item 4 of the original finding): waitForMemoryHeadroom used to have exactly one
 * caller, the pre-push check, while the commands that actually pinned the box were the ones an already-admitted
 * turn ran in the middle of itself. bin/memory-gate is that same policy as a command, and these tests are about
 * the WIRING — that queue-run calls it, in the right order, with what it was told, and that not one of its
 * failure modes can cost the command. The policy itself is a pure function tested in memory-admission.test.ts.
 *
 * A stub on PATH rather than the real binary: the real one reads this container's live cgroup, so asserting on
 * its verdict would be asserting on how busy the box happens to be. */
const stubGate = async (script: string): Promise<string> => {
    const bin = await mkdtemp(join(tmpdir(), "queue-bin-"));
    await writeFile(join(bin, "memory-gate"), `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
    return bin;
};

test("the memory gate runs before the command, and is told the deadline and the label", async () => {
    const queue = await dir();
    const seen = join(queue, "gate-args");
    const bin = await stubGate(`echo "$@" > ${seen}; echo gate >> ${join(queue, "order")}`);
    const run = await queueRun(
        queue,
        ["--pool", "p", "--limit", "1", "--memory-gate", "7", "--label", "vitest"],
        `echo cmd >> ${join(queue, "order")}`,
        bin,
    );
    expect(run.code).toBe(0);
    expect(await readFile(seen, "utf8")).toContain("--deadline-seconds 7 --label vitest");
    // Before, not after: a box with no room should not first burn a slot sitting in it.
    expect((await readFile(join(queue, "order"), "utf8")).split("\n").filter(Boolean)).toEqual(["gate", "cmd"]);
});

test("no memory gate is asked for when the deadline is zero", async () => {
    const queue = await dir();
    const bin = await stubGate(`echo called > ${join(queue, "called")}`);
    const run = await queueRun(queue, ["--pool", "p", "--limit", "1", "--memory-gate", "0"], "echo ran", bin);
    expect(run.stdout.trim()).toBe("ran");
    await expect(readFile(join(queue, "called"), "utf8")).rejects.toThrow();
});

test("a missing or failing memory gate still runs the command", async () => {
    const queue = await dir();
    // Absent from PATH: an older image, a dev daemon, a partial build.
    const absent = await queueRun(
        queue,
        ["--pool", "p", "--limit", "1", "--memory-gate", "5"],
        "echo no-gate",
        await stubGate("exit 0").then(() => "/nonexistent-bin"),
    );
    expect(absent.stdout.trim()).toBe("no-gate");
    // Present and broken: the gate is not allowed to become the reason the owner's work did not run.
    const broken = await queueRun(queue, ["--pool", "q", "--limit", "1", "--memory-gate", "5"], "echo despite-failure", await stubGate("exit 9"));
    expect(broken.stdout.trim()).toBe("despite-failure");
    expect(broken.code).toBe(0);
});
