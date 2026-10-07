// WHEN BUN FINISHES EVERY FILE AND DOES NOT EXIT. On run 37694899281 (2026-10-07) verify-clocks' daemon leg reported all
// 125 of its files by 22:32:38 and then printed nothing until the job's 30-minute timeout killed it at 22:59:24: no
// summary, no failure, 27 minutes of a runner held by a process waiting on a handle nobody closed. The leg before it had
// run the same files and exited. A hang like that costs a whole job and says nothing about which test caused it.
//
// So on CI `suites` reads bun's output as it passes it through (it still prints every byte unchanged) and keeps three
// facts: which test files have reported, whether any test failed, and when bun last printed. Bun stops a test at the
// run's per-test timeout, so once it has been silent for longer than that, no test can still be running. What is left to
// tell apart:
//   every expected file has reported and the tree is idle   bun is stuck on its way out. The run is killed and keeps
//                                                            its verdict: a failure seen fails it, otherwise it passes.
//   bun printed its summary and did not exit               the same, said by bun itself.
//   silent past the limit                                   something never reported (a test spinning in a loop no
//                                                            timeout can reach, a worker that never started). Killed
//                                                            and FAILED, naming the files that never reported.
// Idle matters because a test blocked in synchronous code burns a core and cannot be interrupted by bun's timeout; a
// process stuck at exit burns nothing. Linux only, like the memory ceiling: without /proc nothing reads as idle, and
// only the hard limit acts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { processTree } from "./memory-ceiling.mjs";

// A file's heading in bun's output: `path/to/x.test.ts:` alone on its line, inside a `##[group]` on GitHub Actions.
const FILE_HEADING = /^(?:##\[group\])?(\S+\.(?:test|spec)\.[cm]?[jt]sx?):\s*$/u;
const FAILED_TEST = /^\(fail\) /u;
const SUMMARY = /^Ran \d+ tests? across \d+ files?\./u;
// eslint-disable-next-line no-control-regex -- bun colours its output on a terminal; the escapes are not part of a line
const ANSI = /\u001b\[[0-9;]*m/gu;

// Silence past the per-test timeout, with room for a slow teardown to print its last line.
export const GRACE_PAD_MS = 30_000;
// Silence that ends a run whatever it has reported: ten minutes, or three per-test timeouts if that is longer.
export const STALL_FLOOR_MS = 10 * 60_000;
// How often the watch looks, and the CPU a tree may burn in that time and still read as idle (in clock ticks, 100 a
// second on Linux: 50 is half a second of one core in ten).
export const CHECK_MS = 10_000;
export const IDLE_TICKS = 50;

const normal = (file) => file.replace(/^\.\//u, "");

export const createProgress = (expected, now = Date.now()) => ({
    expected: new Set([...expected].map(normal)),
    seen: new Set(),
    failures: 0,
    summary: false,
    lastOutputAt: now,
});

// One line of bun's output, in order.
export const observe = (progress, rawLine, now = Date.now()) => {
    progress.lastOutputAt = now;
    const line = rawLine.replace(ANSI, "").trimEnd();
    const heading = FILE_HEADING.exec(line);
    if (heading) {
        progress.seen.add(normal(heading[1]));
    } else if (FAILED_TEST.test(line)) {
        progress.failures += 1;
    } else if (SUMMARY.test(line)) {
        progress.summary = true;
    }
};

export const unreported = (progress) => [...progress.expected].filter((file) => !progress.seen.has(file));

// What to do now: undefined to keep waiting, or the status to end the run with and why. `timeoutMs` is the run's
// per-test timeout; `idle` whether the tree burned (next to) no CPU since the last look. `padMs` and `floorMs` are the
// two allowances above, which only a test moves.
export const decide = (progress, { now = Date.now(), timeoutMs, idle, padMs = GRACE_PAD_MS, floorMs = STALL_FLOOR_MS }) => {
    const silent = now - progress.lastOutputAt;
    const status = progress.failures > 0 ? 1 : 0;
    const verdict = status === 0 ? "every test it reported passed" : `${String(progress.failures)} reported a failure`;
    const minutes = (ms) => `${(ms / 60_000).toFixed(1)} min`;
    if (silent >= timeoutMs + padMs) {
        if (progress.summary) {
            return { status, why: `bun printed its summary ${minutes(silent)} ago and did not exit; ${verdict}` };
        }
        if (idle && progress.expected.size > 0 && unreported(progress).length === 0) {
            return {
                status,
                why: `bun reported all ${String(progress.expected.size)} files, has printed nothing for ${minutes(silent)} and is idle, so it is stuck on its way out rather than in a test; ${verdict}`,
            };
        }
    }
    if (silent >= Math.max(floorMs, 3 * timeoutMs)) {
        const missing = unreported(progress);
        const named =
            missing.length === 0
                ? ""
                : `; never reported: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? `, and ${String(missing.length - 20)} more` : ""}`;
        return { status: 1, why: `bun printed nothing for ${minutes(silent)}${idle ? "" : " while still burning CPU"}${named}` };
    }
    return undefined;
};

// CPU ticks (user + system) the processes have used, from /proc/<pid>/stat; 0 where it cannot be read.
export const cpuTicks = (pids, procRoot = "/proc") => {
    let ticks = 0;
    for (const pid of pids) {
        try {
            const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            // Fields 14 and 15 of stat(5), counted after the name: utime, stime.
            ticks += Number(fields[11]) + Number(fields[12]);
        } catch {
            // allow(silent-catch): a process that exited between the listing and the read used nothing more
        }
    }
    return ticks;
};

const lines = (stream, sink, onLine) => {
    let rest = "";
    stream.on("data", (chunk) => {
        sink.write(chunk);
        rest += chunk.toString("utf8");
        const parts = rest.split("\n");
        rest = parts.pop() ?? "";
        for (const part of parts) {
            onLine(part);
        }
    });
};

// Passes a spawned bun's piped stdout and stderr through unchanged and watches them (above). When it decides, it says
// why on stderr, kills the whole tree, and remembers the status; `stop()` ends the watch and answers with that decision,
// or undefined when bun exited on its own.
export const watchProgress = (
    child,
    {
        expected,
        timeoutMs,
        checkMs = CHECK_MS,
        padMs,
        floorMs,
        procRoot = "/proc",
        log = (text) => process.stderr.write(text),
        out = process.stdout,
        err = process.stderr,
    },
) => {
    const progress = createProgress(expected);
    const onLine = (line) => observe(progress, line);
    lines(child.stdout, out, onLine);
    lines(child.stderr, err, onLine);
    let decided;
    let lastTicks;
    const timer = setInterval(() => {
        if (child.pid === undefined) {
            return;
        }
        const tree = processTree(child.pid, procRoot);
        const ticks = cpuTicks(tree, procRoot);
        const idle = lastTicks !== undefined && tree.length > 0 && ticks - lastTicks <= IDLE_TICKS;
        lastTicks = ticks;
        const decision = decide(progress, { timeoutMs, idle, padMs, floorMs });
        if (decision === undefined) {
            return;
        }
        decided = decision;
        clearInterval(timer);
        log(
            `\nsuites: ${decision.why}. Killed it rather than wait for the job's timeout, and the run ${decision.status === 0 ? "passes" : "fails"}.\n`,
        );
        for (const pid of tree.toReversed()) {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                // allow(silent-catch): a process already gone is the outcome the kill was for
            }
        }
    }, checkMs);
    timer.unref();
    return () => {
        clearInterval(timer);
        return decided;
    };
};
