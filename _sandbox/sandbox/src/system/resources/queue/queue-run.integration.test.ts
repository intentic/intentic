import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { opt } from "../../../opt.js";

// Exercises real processes and a real flock, not the pure policy (tested elsewhere): what happens to a slot when a
// process doesn't exit politely. Assertions are on order, count and lock ownership; readiness bounds detect hangs.

const QUEUE_RUN = join(packageRoot(import.meta.url), "bin", "queue-run");

interface Run {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

// `bash <path>`, not the path itself: it's mode 644 in git, executable only after the Dockerfile's chmod.
// `onStderr` sees the stderr read so far as it grows: a test frees a slot the moment the waiter says it waits, rather
// than sizing a holder's sleep to outlast the waiter's start.
const queueRun = (
    dir: string,
    args: readonly string[],
    command: string,
    pathPrefix?: string,
    extraEnv: NodeJS.ProcessEnv = {},
    onStderr?: (soFar: string) => void,
): Promise<Run> =>
    new Promise((resolve) => {
        const child = spawn("bash", [QUEUE_RUN, ...args, "--", "bash", "-c", command], {
            env: {
                ...process.env,
                INTENTIC_QUEUE_CAPTURE_DIR: "",
                // This suite may itself run under queue-run, whose gate would otherwise pass to every command here.
                INTENTIC_QUEUE_GATE: "",
                INTENTIC_ROOM_ADMITTED: "",
                ...extraEnv,
                INTENTIC_QUEUE_DIR: dir,
                INTENTIC_QUEUE_POLL: "1",
                ...opt("PATH", pathPrefix === undefined ? undefined : `${pathPrefix}:${process.env["PATH"] ?? ""}`),
            },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
            onStderr?.(stderr);
        });
        child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

// Frees the holder's slot once the waiter has said it waits and named who holds it.
const releaseOnceWaiting = (holder: ChildProcess) => (soFar: string): void => {
    if (soFar.includes("(holders and waiters:")) {
        holder.kill("SIGKILL");
    }
};

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
    await rm(held, { force: true });
    const child = spawn("bash", [QUEUE_RUN, ...args, "--", "bash", "-c", `echo held > ${held}; sleep ${seconds}`], {
        env: { ...process.env, INTENTIC_QUEUE_CAPTURE_DIR: "", INTENTIC_QUEUE_GATE: "", INTENTIC_QUEUE_DIR: queue, INTENTIC_QUEUE_POLL: "1" },
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

// The queue directory is shared with fenced turns, whose user owns what root owns there: a slot planted as a link
// must not make root's open truncate what it names, and a pool planted as a link is no pool at all.
test("a slot or a pool planted as a link is never opened through, and the command still runs", async () => {
    const queue = await dir();
    const victim = join(queue, "victim.txt");
    await writeFile(victim, "precious\n");
    await mkdir(join(queue, "p"), { recursive: true });
    await symlink(victim, join(queue, "p", "slot.1"));
    const run = await queueRun(queue, ["--pool", "p", "--limit", "2"], "echo ran");
    expect(run.stdout.trim()).toBe("ran");
    expect(await readFile(victim, "utf8")).toBe("precious\n");

    const elsewhere = await dir();
    await symlink(elsewhere, join(queue, "q"));
    expect((await queueRun(queue, ["--pool", "q", "--limit", "1"], "echo ran")).stdout.trim()).toBe("ran");
    expect(await readdir(elsewhere)).toEqual([]);
});

test("holds the pool to its limit, and every queued command still runs", async () => {
    const queue = await dir();
    const log = join(queue, "marks");
    // Five requests against two slots: the sixth must never run third, and two must run together.
    const runs = await Promise.all(Array.from({ length: 5 }, () => queueRun(queue, ["--pool", "p", "--limit", "2"], body(log, { together: 2 }))));
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

// How the repo-verify rule serialises without leaving the pool: a lower limit sees fewer slots, so two of those
// commands cannot overlap, while everything else still reaches the slots above.
test("a command limited to one serialises with its own kind, and the rest of the pool stays usable", async () => {
    const queue = await dir();
    const holder = await holdSlot(queue, ["--pool", "p", "--limit", "1"], 30);
    try {
        const alsoOne = await queueRun(queue, ["--pool", "p", "--limit", "1", "--wait", "1"], "echo serialised");
        // Only slot.1 is visible to it, and the holder has that, so it waits out the deadline.
        expect(alsoOne.stderr).toContain("starting anyway");

        const two = await queueRun(queue, ["--pool", "p", "--limit", "2", "--wait", "5"], "echo parallel");
        expect(two.stdout.trim()).toBe("parallel");
        expect(two.stderr).not.toContain("starting anyway");
    } finally {
        holder.kill("SIGKILL");
    }
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

test("a HUNG command is killed at the ceiling, and the slot it was holding goes back to the pool", async () => {
    const queue = await dir();
    // The shape that leaked one: a pipeline whose writer never returns, so its reader never sees EOF either, and
    // both of them go on holding the slot's descriptor. Killing only the direct child would leave the lock held.
    const hung = await queueRun(queue, ["--pool", "p", "--limit", "1", "--max-hold", "1"], "sleep 600 | tail -1");
    expect(hung.code).toBe(124);

    const after = await queueRun(queue, ["--pool", "p", "--limit", "1", "--wait", "5"], "echo free");
    expect(after.stdout.trim()).toBe("free");
    // Took the slot rather than timing out into it, which is the difference between released and merely expired.
    expect(after.stderr).not.toContain("starting anyway");
});

test("a command that finishes inside the ceiling keeps its own exit code", async () => {
    const run = await queueRun(await dir(), ["--pool", "p", "--limit", "1", "--max-hold", "60"], "echo done; exit 5");
    expect(run.stdout.trim()).toBe("done");
    expect(run.code).toBe(5);
});

test("no ceiling asked for is no ceiling applied", async () => {
    const run = await queueRun(await dir(), ["--pool", "p", "--limit", "1"], "sleep 2; echo survived");
    expect(run.stdout.trim()).toBe("survived");
    expect(run.code).toBe(0);
});

test("the deadline path holds no slot, so the ceiling must not reach it", async () => {
    const queue = await dir();
    const holder = await holdSlot(queue, ["--pool", "p", "--limit", "1"], 30);
    try {
        // Starts unqueued once the deadline passes, then outlives the ceiling twice over: killing it would free no
        // slot, because it never got one.
        const ran = await queueRun(queue, ["--pool", "p", "--limit", "1", "--wait", "1", "--max-hold", "1"], "sleep 2; echo unbounded");
        expect(ran.stderr).toContain("starting anyway");
        expect(ran.stdout.trim()).toBe("unbounded");
        expect(ran.code).toBe(0);
    } finally {
        holder.kill("SIGKILL");
    }
});

test("runs anyway once the deadline passes, rather than blocking forever", async () => {
    const queue = await dir();
    const holder = await holdSlot(queue, ["--pool", "p", "--limit", "1"], 10);
    try {
        const waited = await queueRun(queue, ["--pool", "p", "--limit", "1", "--wait", "1"], "echo ran; exit 4");
        expect(waited.stdout.trim()).toBe("ran");
        expect(waited.code).toBe(4);
        expect(waited.stderr).toContain('pool "p"');
        expect(waited.stderr).toMatch(/starting anyway|slot free after/);
    } finally {
        holder.kill("SIGKILL");
    }
});

// Observe the real blocking flock calls before freeing a slot. Holders wait on stdin so process scheduling cannot
// free either slot before the waiter is registered, and no elapsed-time threshold decides whether it woke correctly.
test("a waiter blocks in the kernel, takes the first freed slot, and keeps its lock", async () => {
    const queue = await dir();
    const bin = join(queue, "bin");
    const waiting = join(queue, "blocking-locks");
    await mkdir(bin);
    await writeFile(waiting, "");
    await writeFile(
        join(bin, "flock"),
        `#!/usr/bin/env bash
if [ "$1" = "-w" ]; then printf '%s\n' "$3" >> '${waiting}'; fi
PATH="\${PATH#*:}" exec flock "$@"
`,
        { mode: 0o755 },
    );
    const holder = (name: string) => spawn(
        "bash", [QUEUE_RUN, "--pool", "p", "--limit", "2", "--", "bash", "-c", `readlink /proc/$$/fd/9 > '${join(queue, name)}'; read -r _`],
        { env: { ...process.env, INTENTIC_QUEUE_CAPTURE_DIR: "", INTENTIC_QUEUE_DIR: queue } },
    );
    const first = holder("first");
    const second = holder("second");
    let waiter: Promise<Run> | undefined;
    try {
        const firstSlot = await waitFor(async () => {
            const slot = (await readFile(join(queue, "first"), "utf8")).trim();
            expect(slot).toMatch(/\/p\/slot\.[12]$/);
            return slot;
        }, SETTLES);
        await waitFor(async () => expect((await readFile(join(queue, "second"), "utf8")).trim()).toMatch(/\/p\/slot\.[12]$/), SETTLES);
        waiter = queueRun(queue, ["--pool", "p", "--limit", "2", "--wait", "30"],
            `if flock -n '${firstSlot}' true; then echo unlocked; fi; readlink /proc/$$/fd/9`, bin);
        await waitFor(async () => expect((await readFile(waiting, "utf8")).trim().split("\n").toSorted()).toEqual(["21", "22"]), SETTLES);
        first.stdin.end("release\n");
        const ran = await waiter;
        expect(ran.code).toBe(0);
        expect(ran.stderr).toContain("slot free after");
        expect(ran.stdout.trim()).toBe(firstSlot);
    } finally {
        first.stdin.end();
        second.stdin.end();
        first.kill("SIGKILL");
        second.kill("SIGKILL");
        await waiter;
    }
});

test("says in the pane that it is waiting, then that it started", async () => {
    const queue = await dir();
    // Held until the second command has said it waits, then freed, so it goes on to start inside its deadline.
    const holder = await holdSlot(queue, ["--pool", "p", "--limit", "1", "--label", "vitest"], 30);
    const second = await queueRun(
        queue,
        ["--pool", "p", "--limit", "1", "--wait", "30", "--label", "vitest"],
        "echo second",
        undefined,
        {},
        releaseOnceWaiting(holder),
    );
    expect(second.stderr).toContain('pool "p"');
    expect(second.stderr).toContain("vitest");
    expect(second.stderr).toMatch(/waiting|slot free after/);
    expect(second.stdout.trim()).toBe("second");
    holder.kill("SIGKILL");
});

test("names who holds the pool while it waits, says so again as the wait goes on, and keeps the pool's state on file", async () => {
    const queue = await dir();
    const held = join(queue, "held");
    const holder = spawn("bash", [QUEUE_RUN, "--pool", "p", "--limit", "1", "--", "bash", "-c", `echo held > ${held}; sleep 30`], {
        env: {
            ...process.env,
            INTENTIC_QUEUE_CAPTURE_DIR: "",
            INTENTIC_QUEUE_GATE: "",
            INTENTIC_ROOM_ADMITTED: "",
            INTENTIC_QUEUE_DIR: queue,
            INTENTIC_TURN_OWNER: "holding-conversation",
            INTENTIC_HEAVY_HELD: "bun-test",
        },
    });
    for (let tries = 0; tries < RENDEZVOUS_SECONDS / POLL_SECONDS && !(await readdir(queue)).includes("held"); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
    }
    const state = join(queue, "p", "state.json");
    // The waiting command prints the pool's state as it saw it while it waited, which is what a diagnostics read gets.
    const second = await new Promise<Run>((resolve) => {
        const child = spawn("bash", [QUEUE_RUN, "--pool", "p", "--limit", "1", "--wait", "30", "--label", "second", "--", "bash", "-c", "echo ran"], {
            env: {
                ...process.env,
                INTENTIC_QUEUE_CAPTURE_DIR: "",
                INTENTIC_QUEUE_GATE: "",
                INTENTIC_ROOM_ADMITTED: "",
                INTENTIC_QUEUE_DIR: queue,
                INTENTIC_QUEUE_POLL: "1",
                INTENTIC_QUEUE_SAY_EVERY: "1",
                INTENTIC_TURN_OWNER: "waiting-conversation",
            },
        });
        let stderr = "";
        let seen = "";
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
            if (seen === "" && stderr.includes("holders and waiters:")) {
                try {
                    seen = readFileSync(state, "utf8");
                } catch {
                    // allow(silent-catch): read when the file is available
                }
            }
            // Freed once the wait has been said again and the state it saw is read: the rest is the waiter starting.
            if (stderr.includes("still waiting after")) {
                if (seen === "") {
                    try {
                        seen = readFileSync(state, "utf8");
                    } catch {
                        // allow(silent-catch)
                    }
                }
                holder.kill("SIGKILL");
            }
        });
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.on("close", (code) => resolve({ code, stdout: `${stdout}${seen}`, stderr }));
    });
    expect(second.stderr).toMatch(/slot\.1: pid \d+, running \d+s by rule bun-test for conversation holding-conversation: .*sleep 30/);
    expect(second.stderr).toContain(`(holders and waiters: ${state})`);
    expect(second.stderr).toMatch(/still waiting after \d+s for pool "p"/);
    const [ran, json] = second.stdout.split("\n");
    expect(ran).toBe("ran");
    expect(JSON.parse(json ?? "")).toMatchObject({
        pool: "p",
        limit: 1,
        holders: [{ slot: "slot.1", conversation: "holding-conversation", rule: "bun-test" }],
        waiters: [{ label: "second", conversation: "waiting-conversation" }],
    });
    // Once it runs it waits no more: its own entry is gone, and the state on file no longer lists it.
    expect((await readdir(join(queue, "p"))).filter((name) => name.startsWith("wait."))).toEqual([]);
    expect(JSON.parse(await readFile(state, "utf8"))).toMatchObject({ waiters: [] });
    holder.kill("SIGKILL");
});

// None of these malformed inputs should come from the daemon; every one must still run the command.
test.each([
    ["a bad limit", ["--pool", "p", "--limit", "not-a-number"]],
    ["a bad deadline", ["--pool", "p", "--limit", "1", "--wait", "abc"]],
    ["a bad hold ceiling", ["--pool", "p", "--limit", "1", "--max-hold", "abc"]],
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
            env: { ...process.env, INTENTIC_QUEUE_CAPTURE_DIR: "", INTENTIC_QUEUE_DIR: queue },
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("close", (code) => resolve({ code, stdout: "", stderr }));
    });
    expect(run.code).toBe(0);
});

// Tests the wiring to memory-room (order, args, failure tolerance), not the policy itself (resource-budget.test.ts,
// memory-room.test.ts). A stub avoids asserting on this container's real cgroup state and on a live daemon's answer.
const stubGate = async (script: string): Promise<string> => {
    const bin = await mkdtemp(join(tmpdir(), "queue-bin-"));
    await writeFile(join(bin, "memory-room"), `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
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
    // `--pid` is queue-run's own, which the command becomes at its exec: the budget hands the room back when it exits.
    // `--ceiling` is the slot's own wait, up to which a command short of even a person's turn's room is held (memory-floor.mjs).
    expect(await readFile(seen, "utf8")).toMatch(/^--class toolchain --wait 7 --ceiling 900 --label vitest --pid \d+ --admitted\n$/u);
    // Before, not after: a box with no room should not first burn a slot sitting in it.
    expect((await readFile(join(queue, "order"), "utf8")).split("\n").filter(Boolean)).toEqual(["gate", "cmd"]);
});

test("the gate is told the pid the command runs as and the rule's size by name; a size that is not one word is dropped", async () => {
    const queue = await dir();
    const seen = join(queue, "gate-args");
    const bin = await stubGate(`echo "$@" >> ${seen}`);
    const run = await queueRun(queue, ["--pool", "p", "--limit", "1", "--memory-gate", "7", "--size", "targeted"], "echo $$", bin);
    const pid = run.stdout.trim();
    // Every name is passed on, the editor's lane included: memory-room knows the prices and gives any other name the
    // class's, so this list is never a second copy of SIZE_BYTES.
    await queueRun(queue, ["--pool", "p", "--limit", "1", "--memory-gate", "7", "--size", "editor-typecheck"], "true", bin);
    await queueRun(queue, ["--pool", "p", "--limit", "1", "--memory-gate", "7", "--size", "scoped-typecheck"], "true", bin);
    await queueRun(queue, ["--pool", "p", "--limit", "1", "--memory-gate", "7", "--size", "Huge size;"], "true", bin);
    const [targeted, editor, scoped, malformed] = (await readFile(seen, "utf8")).trim().split("\n");
    expect(targeted).toBe(`--class toolchain --wait 7 --ceiling 900 --label command --pid ${pid} --admitted --size targeted`);
    expect(editor).toMatch(/--pid \d+ --admitted --size editor-typecheck$/u);
    expect(scoped).toMatch(/--pid \d+ --admitted --size scoped-typecheck$/u);
    expect(malformed).toMatch(/--pid \d+ --admitted$/u);
});

// (2026-11-25) An agent's line queued by what it took last time runs as `bash <run dir>/agent`, which names nothing: the
// daemon names it (learned-lines.ts), and queue-run hands that name to the gate and says why it queues.
test("a command named outright is named so to the gate, and its note is said before it queues", async () => {
    const queue = await dir();
    const seen = join(queue, "gate-args");
    const bin = await stubGate(`printf '%s|' "$@" > ${seen}`);
    const run = await queueRun(
        queue,
        ["--pool", "learned", "--limit", "2", "--memory-gate", "7", "--label", "learned", "--key", "learned @x: python3 gen.py", "--command", "python3 gen.py", "--note", "it peaked at 3.5 GiB"],
        "echo ran",
        bin,
    );
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe("ran");
    expect(run.stderr).toContain("[queue-run] learned: it peaked at 3.5 GiB\n");
    expect(await readFile(seen, "utf8")).toMatch(/--label\|learned\|--pid\|\d+\|--admitted\|--key\|learned @x: python3 gen.py\|--command\|python3 gen.py\|$/u);
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
    // Absent from PATH: an older image, a dev daemon, a partial build. A PATH of the system's own directories, since the
    // sandbox running this suite has the real memory-room in /usr/local/bin, which would judge this machine's memory.
    const absent = await queueRun(queue, ["--pool", "p", "--limit", "1", "--memory-gate", "5"], "echo no-gate", undefined, { PATH: "/usr/bin:/bin" });
    expect(absent.stdout.trim()).toBe("no-gate");
    // Present and broken: the gate is not allowed to become the reason the owner's work did not run.
    const broken = await queueRun(queue, ["--pool", "q", "--limit", "1", "--memory-gate", "5"], "echo despite-failure", await stubGate("exit 9"));
    expect(broken.stdout.trim()).toBe("despite-failure");
    expect(broken.code).toBe(0);
});

// (2026-11-19) memory-room exits 75 only when it held the command to its ceiling with less free than a person's turn
// needs: a heavy command started into that was killed by the memory guard, taking others with it.
test("a command the memory gate held below the floor to its ceiling is not started, and says so with 75", async () => {
    const queue = await dir();
    const run = await queueRun(queue, ["--pool", "p", "--limit", "1", "--memory-gate", "5"], `echo ran > ${join(queue, "ran")}`, await stubGate("exit 75"));
    expect(run.code).toBe(75);
    await expect(readFile(join(queue, "ran"), "utf8")).rejects.toThrow();
});

test("what the gate's admission holds for the command reaches it, for its launcher to size its jobs to", async () => {
    const queue = await dir();
    const run = await queueRun(queue, ["--pool", "p", "--limit", "1", "--memory-gate", "5"], "echo \"$INTENTIC_ROOM_ADMITTED\"", await stubGate("echo 7516192768"));
    expect(run.stdout.trim()).toBe("7516192768");
    const unknown = await queueRun(queue, ["--pool", "p", "--limit", "1", "--memory-gate", "5"], "echo \"[${INTENTIC_ROOM_ADMITTED:-}]\"", await stubGate("echo not-a-number"));
    expect(unknown.stdout.trim()).toBe("[]");
});

// (2026-11-19, the shinobi-society audit) A project's motion capture had to run with nothing else heavy beside it, and
// kept its own lock for that; a class declared exclusive, or a quiet run (bin/quiet), passes `--exclusive` instead.
describe("the gate: a command with nothing else heavy beside it", () => {
    const alone = ["--pool", "capture", "--limit", "1", "--exclusive", "--label", "capture"];

    test("a new command waits while it runs, told who holds the sandbox, and starts once it ends", async () => {
        const queue = await dir();
        const holder = await holdSlot(queue, alone, 30);
        const waiter = await queueRun(queue, ["--pool", "p", "--limit", "2", "--label", "cargo"], "echo after", undefined, {}, (soFar) => {
            if (soFar.includes("capture: pid")) {
                holder.kill("SIGKILL");
            }
        });
        expect(waiter.code).toBe(0);
        expect(waiter.stdout.trim()).toBe("after");
        expect(waiter.stderr).toContain("[queue-run] cargo: waiting: a command that must run with nothing else heavy beside it holds this sandbox");
        expect(waiter.stderr).toMatch(/\[queue-run\] {3}capture: pid \d+, running \d+s/u);
        expect(waiter.stderr).not.toContain("starting beside it");
    });

    test("it waits for the commands let in before it, holds the ones that come after, and runs before them", async () => {
        const queue = await dir();
        const order = join(queue, "order");
        const running = await holdSlot(queue, ["--pool", "p", "--limit", "2", "--label", "build"], 30);
        let later: Promise<Run> | undefined;
        // The next command comes once the exclusive one has named what it waits for, and the build ends once that one waits.
        const first = await queueRun(queue, alone, `echo capture >> ${order}; sleep 0.3`, undefined, {}, (soFar) => {
            if (later === undefined && /\[queue-run\] {3}pid \d+, running \d+s/u.test(soFar)) {
                later = queueRun(queue, ["--pool", "p", "--limit", "2", "--label", "test"], `echo test >> ${order}`, undefined, {}, (waiting) => {
                    if (waiting.includes("capture: pid")) {
                        running.kill("SIGKILL");
                    }
                });
            }
        });
        const second = await later;
        expect([first.code, second?.code]).toEqual([0, 0]);
        expect(first.stderr).toContain("[queue-run] capture: runs alone: holding new heavy commands in this sandbox");
        expect(first.stderr).toMatch(/\[queue-run\] {3}pid \d+, running \d+s.*: sleep 30/u);
        expect((await readFile(order, "utf8")).trim().split("\n")).toEqual(["capture", "test"]);
    });

    test("a command under one that already took a side of the gate never waits on it", async () => {
        const queue = await dir();
        const holder = await holdSlot(queue, alone, 30);
        try {
            const inside = await queueRun(queue, ["--pool", "q", "--limit", "1"], "echo inside", undefined, { INTENTIC_QUEUE_GATE: "exclusive" });
            expect(inside.stdout.trim()).toBe("inside");
            expect(inside.stderr).toBe("");
        } finally {
            holder.kill("SIGKILL");
        }
    });

    test("the wait for it is bounded: then the command starts beside it, or with `skip` does not start", async () => {
        const queue = await dir();
        const holder = await holdSlot(queue, alone, 30);
        try {
            const beside = await queueRun(queue, ["--pool", "p", "--limit", "1"], "echo beside", undefined, { INTENTIC_QUEUE_GATE_WAIT: "1" });
            expect(beside.stdout.trim()).toBe("beside");
            expect(beside.stderr).toContain("the command running alone did not end within 1s — starting beside it.");
            const skipped = await queueRun(queue, ["--pool", "p", "--limit", "1", "--on-deadline", "skip"], "echo never", undefined, { INTENTIC_QUEUE_GATE_WAIT: "1" });
            expect(skipped.code).toBe(75);
            expect(skipped.stdout).toBe("");
        } finally {
            holder.kill("SIGKILL");
        }
    });

    // (2026-11-24, the shinobi-society audit) A quiet run waited for idle cores after it took the gate exclusive, up to its
    // whole --wait in which nothing else heavy in the sandbox could start. Its launcher now judges calm first, holding nothing.
    const calmStub = async (queue: string): Promise<{ launcher: string; log: string }> => {
        const launcher = join(queue, "calm-stub.cjs");
        const log = join(queue, "calm.log");
        await writeFile(
            launcher,
            `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), heavy: process.env.INTENTIC_HEAVY ?? null }) + "\\n");\n` +
                `process.stdout.write("calm after 3s\\nsecond line\\n");\n`,
        );
        return { launcher, log };
    };
    const calmLog = (log: string): { args: string[]; heavy: string | null }[] =>
        readFileSync(log, "utf8")
            .trim()
            .split("\n")
            // SAFETY: every line is one the stub launcher wrote with JSON.stringify of exactly this shape.
            .map((line) => JSON.parse(line) as { args: string[]; heavy: string | null });

    test("a quiet run judges calm before the gate, holding nothing, and hands its verdict to the command", async () => {
        const queue = await dir();
        const { launcher, log } = await calmStub(queue);
        const holder = await holdSlot(queue, alone, 30);
        let judgedWhileHeld = false;
        const quiet = await queueRun(
            queue,
            [...alone, "--wait", "40", "--calm-launcher", launcher, "--calm-idle", "6"],
            'echo "[$INTENTIC_QUIET_CALM]"',
            undefined,
            { INTENTIC_HEAVY: "{}" },
            (soFar) => {
                // Waiting at the turnstile behind the holder: the judgment has already been made.
                if (!judgedWhileHeld && soFar.includes("waiting: a command that must run with nothing else heavy beside it")) {
                    judgedWhileHeld = calmLog(log).length === 1;
                    holder.kill("SIGKILL");
                }
            },
        );
        expect(quiet.code).toBe(0);
        expect(judgedWhileHeld).toBe(true);
        expect(quiet.stdout.trim()).toBe("[calm after 3s]");
        // The judgment is never itself queued by node's heavy hook.
        expect(calmLog(log)).toEqual([{ args: ["--calm-first", "--calm-wait", "40", "--label", "capture", "--idle", "6", "--"], heavy: "" }]);
    });

    test("no judgment for a command that is not exclusive, or under one that already took a side of the gate", async () => {
        const queue = await dir();
        const { launcher, log } = await calmStub(queue);
        const plain = await queueRun(queue, ["--pool", "p", "--limit", "1", "--calm-launcher", launcher], 'echo "[${INTENTIC_QUIET_CALM:-}]"');
        expect(plain.stdout.trim()).toBe("[]");
        const inside = await queueRun(queue, [...alone, "--calm-launcher", launcher], 'echo "[${INTENTIC_QUIET_CALM:-}]"', undefined, { INTENTIC_QUEUE_GATE: "exclusive" });
        expect(inside.stdout.trim()).toBe("[]");
        expect(await readdir(queue)).not.toContain("calm.log");
        // A launcher that is not there only skips the wait.
        const missing = await queueRun(queue, [...alone, "--calm-launcher", join(queue, "absent.cjs")], "echo ran");
        expect(missing.stdout.trim()).toBe("ran");
    });

    test("a gate planted as a link is never opened through, and the command still runs", async () => {
        const queue = await dir();
        const elsewhere = await dir();
        await symlink(elsewhere, join(queue, ".gate"));
        expect((await queueRun(queue, ["--pool", "p", "--limit", "1"], "echo ran")).stdout.trim()).toBe("ran");
        expect((await queueRun(queue, alone, "echo alone")).stdout.trim()).toBe("alone");
        expect(await readdir(elsewhere)).toEqual([]);
    });
});

// A rule may say that running beside a slot holder is worse than not running: repo-wide verification, where two at once
// is the measured peak. Then the deadline ends in exit 75 and nothing started, which the caller records as not measured.
test("--on-deadline skip exits 75 without running once the wait is up", async () => {
    const queue = await dir();
    const holder = await holdSlot(queue, ["--pool", "p", "--limit", "1"], 30);
    try {
        const skipped = await queueRun(queue, ["--pool", "p", "--limit", "1", "--wait", "1", "--on-deadline", "skip"], "echo ran");
        expect(skipped.code).toBe(75);
        expect(skipped.stdout).toBe("");
        expect(skipped.stderr).toContain("not started");
        expect(skipped.stderr).not.toContain("starting anyway");
    } finally {
        holder.kill("SIGKILL");
    }
});

test("--on-deadline skip changes nothing for a command that gets its slot in time", async () => {
    const queue = await dir();
    const holder = await holdSlot(queue, ["--pool", "p", "--limit", "1"], 30);
    const second = await queueRun(
        queue,
        ["--pool", "p", "--limit", "1", "--wait", "30", "--on-deadline", "skip"],
        "echo second; exit 4",
        undefined,
        {},
        releaseOnceWaiting(holder),
    );
    expect(second.stdout.trim()).toBe("second");
    expect(second.code).toBe(4);
    holder.kill("SIGKILL");
});

test("an unknown deadline mode reads as run, so the wrapper is never the reason a command did not run", async () => {
    const queue = await dir();
    const holder = await holdSlot(queue, ["--pool", "p", "--limit", "1"], 30);
    try {
        const ran = await queueRun(queue, ["--pool", "p", "--limit", "1", "--wait", "1", "--on-deadline", "later"], "echo ran");
        expect(ran.stdout.trim()).toBe("ran");
        expect(ran.stderr).toContain("starting anyway");
    } finally {
        holder.kill("SIGKILL");
    }
});

test("a terminal capture retains the queue interval and its position and holders, closed on the skip deadline", async () => {
    const queue = await dir();
    const capture = join(queue, "terminal-waits");
    const holder = await holdSlot(queue, ["--pool", "p", "--limit", "1"], 30);
    try {
        const result = await queueRun(queue, ["--pool", "p", "--limit", "1", "--wait", "1", "--on-deadline", "skip"], "echo should-not-run", undefined, { INTENTIC_QUEUE_CAPTURE_DIR: capture });
        expect(result.code).toBe(75);
        expect(result.stdout).toBe("");
        const entries = (await readdir(capture)).filter((name) => name.startsWith("wait."));
        expect(entries).toHaveLength(1);
        const [interval, note] = (await readFile(join(capture, entries[0] ?? ""), "utf8")).trim().split("\n");
        const [start = 0, end = 0] = (interval ?? "").split(" ").map(Number);
        expect(end - start).toBeGreaterThanOrEqual(100);
        expect(note).toContain(`queued: position 1, behind pid ${String(holder.pid)}`);
        expect(note).toContain("(pool p)");
    } finally {
        holder.kill("SIGKILL");
    }
});
