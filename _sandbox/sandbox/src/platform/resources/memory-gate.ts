#!/usr/bin/env node
import { parseArgs } from "node:util";
import { errorMessage } from "@intentic/base/errors";
import { readMemoryHeadroom, waitForMemoryHeadroom } from "./memory-admission.js";

/* THE ADMISSION GATE, ON A COMMAND INSTEAD OF A TURN, as one small binary bin/queue-run can call.
 *
 * waitForMemoryHeadroom had exactly one caller (prepush/prepush.ts), and the case it was written for is not
 * the case that keeps happening. A push is one event the owner triggers and walks away from; the freezes in
 * the resource log are four agent sessions each running a suite inside a turn that was admitted while the box
 * was still fine. Those commands passed no gate at all, because admitTurn fires when a TURN starts and nothing
 * looks again afterwards.
 *
 * IT IS A BINARY RATHER THAN A HOOK because of WHERE the waiting has to happen. Waiting inside the PreToolUse
 * hook would block the daemon's own handler for the whole wait — a hook is an await the SDK is sitting on, and
 * a two-minute one risks the SDK's own hook deadline and blocks that turn's event handling besides. In the
 * pane the same wait is free: the command simply has not started, the user can watch it not start, and the
 * daemon is not in the loop at all. That is also why this prints — the pane is the screen the person watching
 * the queue is already looking at.
 *
 * FAIL OPEN, ALWAYS. Every exit is 0. A gate that cannot read its own cgroup, or that throws, must degrade to
 * "run the command", never to "refuse the owner's work": this process standing between an agent and its shell
 * is only defensible while it cannot become the reason nothing runs. The exit code is checked by nothing, and
 * queue-run runs the command whatever happens here. */

const { values } = parseArgs({
    options: {
        // How long to wait for headroom before giving up and letting the command run anyway. 0 checks once and
        // returns immediately, which is how a caller asks for a report rather than a gate.
        "deadline-seconds": { type: "string", default: "120" },
        // Poll interval. Matches waitForMemoryHeadroom's own default; exposed so the test can drive it fast.
        "interval-seconds": { type: "string", default: "5" },
        // What is being waited FOR, echoed into the notice so the pane says which rule held the command.
        label: { type: "string", default: "command" },
    },
    // The command being gated follows on the same line for readability; this binary never runs it.
    allowPositionals: true,
    strict: false,
});

const seconds = (raw: unknown, fallback: number): number => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const deadlineMs = seconds(values["deadline-seconds"], 120) * 1000;
const intervalMs = Math.max(seconds(values["interval-seconds"], 5), 0.05) * 1000;
const label = typeof values.label === "string" ? values.label : "command";

const gib = (bytes: number | undefined): string => (bytes === undefined ? "?" : `${(bytes / 1024 ** 3).toFixed(1)} GiB`);

try {
    const before = await readMemoryHeadroom();
    // An uncapped sandbox (the hosted shape) or a daemon that cannot see a cgroup learns nothing here and says
    // nothing: admitTurn already treats an unknown ceiling as "admit", and a notice about a limit that does not
    // exist would be noise in every pane on those boxes.
    if (before.limitBytes === undefined) {
        process.exit(0);
    }
    const wait = await waitForMemoryHeadroom({ deadlineMs, intervalMs });
    if (wait.waitedMs > 0) {
        const after = await readMemoryHeadroom();
        process.stderr.write(
            wait.admitted
                ? `[memory-gate] ${label}: waited ${Math.round(wait.waitedMs / 1000)}s for memory, ${gib(after.freeBytes)} free — starting.\n`
                : `[memory-gate] ${label}: still short of memory after ${Math.round(wait.waitedMs / 1000)}s (${gib(after.freeBytes)} free) — starting anyway.\n`,
        );
    }
} catch (error) {
    process.stderr.write(`[memory-gate] skipped: ${errorMessage(error)}\n`);
}
process.exit(0);
