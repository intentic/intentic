import { spawn } from "node:child_process";
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
 * latency: every assertion is about ORDER and COUNT, never about how long something took. */

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

const body = (log: string, ms = 300): string => `echo + >> ${log}; sleep ${ms / 1000}; echo - >> ${log}`;

test("runs the command, passing through its output and its real exit code", async () => {
    const run = await queueRun(await dir(), ["--pool", "p", "--limit", "2"], "echo hello; exit 7");
    expect(run.stdout.trim()).toBe("hello");
    expect(run.code).toBe(7);
});

test("holds the pool to its limit, and every queued command still runs", async () => {
    const queue = await dir();
    const log = join(queue, "marks");
    // Five at once against two slots: the assertion that matters is that the sixth thing the box is asked to
    // do never becomes the third thing it is doing.
    const runs = await Promise.all(Array.from({ length: 5 }, () => queueRun(queue, ["--pool", "p", "--limit", "2"], body(log))));
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
        queueRun(queue, ["--pool", "a", "--limit", "1"], body(log)),
        queueRun(queue, ["--pool", "b", "--limit", "1"], body(log)),
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
    const killed = spawn("bash", [QUEUE_RUN, "--pool", "p", "--limit", "1", "--", "bash", "-c", "sleep 30"], {
        env: { ...process.env, INTENTIC_QUEUE_DIR: queue, INTENTIC_QUEUE_POLL: "1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    killed.kill("SIGKILL");
    await new Promise((resolve) => killed.on("close", resolve));

    const after = await queueRun(queue, ["--pool", "p", "--limit", "1", "--wait", "5"], "echo free");
    expect(after.stdout.trim()).toBe("free");
    // It got the slot rather than timing out into it: the deadline notice is what a leaked slot would print.
    expect(after.stderr).not.toContain("starting anyway");
});

test("runs anyway once the deadline passes, rather than blocking forever", async () => {
    const queue = await dir();
    const holder = spawn("bash", [QUEUE_RUN, "--pool", "p", "--limit", "1", "--", "bash", "-c", "sleep 10"], {
        env: { ...process.env, INTENTIC_QUEUE_DIR: queue, INTENTIC_QUEUE_POLL: "1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
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
    const holder = spawn("bash", [QUEUE_RUN, "--pool", "p", "--limit", "1", "--label", "vitest", "--", "bash", "-c", "sleep 1.5"], {
        env: { ...process.env, INTENTIC_QUEUE_DIR: queue, INTENTIC_QUEUE_POLL: "1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
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
    const runs = await Promise.all(Array.from({ length: 4 }, () => queueRun(queue, ["--pool", "p", "--limit", "1"], body(log, 400))));
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
