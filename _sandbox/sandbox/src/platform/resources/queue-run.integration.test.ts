import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

// Exercises real processes and a real flock, not the pure policy (tested elsewhere): what happens to a slot when a
// process doesn't exit politely. Timings are coarse; assertions are on order and count, never on latency.

const QUEUE_RUN = join(import.meta.dirname, "../../../bin/queue-run");

interface Run {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

// `bash <path>`, not the path itself: it's mode 644 in git, executable only after the Dockerfile's chmod.
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

// Peak concurrency, replayed from `+`/`-` marks each body appends; a one-line `>>` append is atomic on Linux.
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

// A body waits inside its bracket until `together` have started, making overlap a fact about the queue, not about
// fork+exec speed; the bound is generous so it costs nothing when unloaded.
const RENDEZVOUS_SECONDS = 30;
const POLL_SECONDS = 0.05;
const body = (log: string, { together = 1, ms = 300 }: { together?: number; ms?: number } = {}): string =>
    `echo + >> ${log}; ` +
    `for _ in $(seq 1 ${Math.round(RENDEZVOUS_SECONDS / POLL_SECONDS)}); do [ "$(grep -c '^+$' ${log})" -ge ${together} ] && break; sleep ${POLL_SECONDS}; done; ` +
    `sleep ${ms / 1000}; echo - >> ${log}`;

// Blocks until the held command's marker file exists, not until spawn returns, so a slot is provably taken before use.
// A bound that expires throws rather than silently proceeding untested.
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
    // Five requests against two slots: the sixth must never run third, and two must run together.
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
    // Two pools of one each must overlap, or the pool name is decoration.
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
    const killed = await holdSlot(queue, ["--pool", "p", "--limit", "1"], 30);
    killed.kill("SIGKILL");
    await new Promise((resolve) => killed.on("close", resolve));

    const after = await queueRun(queue, ["--pool", "p", "--limit", "1", "--wait", "5"], "echo free");
    expect(after.stdout.trim()).toBe("free");
    // Got the slot rather than timing out into it; a leaked slot would print the deadline notice.
    expect(after.stderr).not.toContain("starting anyway");
});

test("runs anyway once the deadline passes, rather than blocking forever", async () => {
    const queue = await dir();
    const holder = await holdSlot(queue, ["--pool", "p", "--limit", "1"], 10);
    try {
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
    // Long enough that the holder still holds when the second command polls; short enough not to wait out the full
    // deadline.
    const holder = await holdSlot(queue, ["--pool", "p", "--limit", "1", "--label", "vitest"], 5);
    const second = await queueRun(queue, ["--pool", "p", "--limit", "1", "--wait", "30", "--label", "vitest"], "echo second");
    expect(second.stderr).toContain('pool "p"');
    expect(second.stderr).toContain("vitest");
    expect(second.stderr).toMatch(/waiting|slot free after/);
    expect(second.stdout.trim()).toBe("second");
    holder.kill("SIGKILL");
});

// None of these malformed inputs should come from the daemon; every one must still run the command.
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
    // The lock must survive exec: `{var}>`-allocated descriptors close on exec and would silently drop it.
    const log = join(queue, "marks");
    const runs = await Promise.all(Array.from({ length: 4 }, () => queueRun(queue, ["--pool", "p", "--limit", "1"], body(log, { ms: 400 }))));
    expect(runs.every((run) => run.code === 0)).toBe(true);
    expect(await peakConcurrency(log)).toBe(1);
});

// Tests the wiring to bin/memory-gate (order, args, failure tolerance), not the policy itself
// (memory-admission.test.ts). A stub avoids asserting on this container's real cgroup state.
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
