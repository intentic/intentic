#!/usr/bin/env node
import { parseArgs } from "node:util";
import { errorMessage } from "@intentic/base/errors";
import { readMemoryHeadroom, waitForMemoryHeadroom } from "./memory-admission.js";

// Gates one shell command, not a turn, so queue-run can call it as a binary rather than block the daemon's PreToolUse
// hook while waiting. Fails open: every exit is 0, even when the cgroup can't be read.

const { values } = parseArgs({
    options: {
        // Seconds to wait for headroom before letting the command run anyway; 0 checks once and returns immediately.
        "deadline-seconds": { type: "string", default: "120" },
        // Poll interval in seconds; exposed so tests can drive it faster than the default.
        "interval-seconds": { type: "string", default: "5" },
        // Echoed into the notice so the pane names which rule held the command.
        label: { type: "string", default: "command" },
    },
    // Positionals are the gated command, shown for readability; this binary never runs it.
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
    // Nothing to report when there is no ceiling: stay silent instead of noting a limit that doesn't exist.
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
