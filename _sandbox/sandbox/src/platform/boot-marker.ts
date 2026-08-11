import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import { pidAlive } from "./pid-alive.js";

/* Make a daemon death loud AFTER the fact. The daemon has died silently many times a day — a V8 fatal error
 * or an outside kill goes to the container's stderr, which `docker rm -f` takes to the grave, and pino's
 * async destination loses even the lines it was handed. So the /history volume carries a tiny marker instead:
 * boot writes "running", every deliberate exit rewrites it synchronously, and the NEXT boot reads what it
 * finds. A marker still saying "running" is a death certificate: the previous process never reached its own
 * exit handler, which means a kill -9, an OOM, or a native crash — and the log line naming it is the
 * difference between "the sandbox restarted six times today" being invisible and being an incident report.
 *
 * Sync writes on purpose, both of them: the boot write is once before serving, and the exit write happens
 * where the loop is already dying — an async write there is exactly the write that gets lost. */

const MARKER_FILE = "daemon-exit.json";

interface ExitMarker {
    readonly state: "running" | "exited";
    readonly pid: number;
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly exitCode?: number;
}

// Diagnostic reports --report-on-fatalerror leaves next to the logs (report.<date>.<pid>.json): name the ones
// the dead run could have written, so the death certificate points straight at the evidence.
const fatalReports = (dir: string, pid: number): string[] => {
    try {
        return readdirSync(dir).filter((name) => name.startsWith("report.") && name.endsWith(`.${pid}.0.json`));
    } catch {
        return [];
    }
};

// Read the previous run's fate, log it when it died unannounced, and take over the marker for this run.
// Returns the writer the exit handler uses. Never throws: a sandbox that cannot write its marker (read-only
// dev run) is a working sandbox with worse forensics.
export const claimBootMarker = (logsDir: string, logger: Logger): { markExited: (code: number) => void } => {
    const path = join(logsDir, MARKER_FILE);
    try {
        const previous = JSON.parse(readFileSync(path, "utf8")) as ExitMarker;
        /* A MARKER STILL SAYING RUNNING, WHOSE PID STILL IS. Not a death at all: another daemon has this history
         * root open right now, and the certificate this function exists to write would be an obituary for the
         * living — which is exactly what it wrote on 2026-08-11, naming the live daemon as OOM-killed while it
         * served four turns. Nothing is claimed either: the marker belongs to that run, and overwriting it would
         * lose the only record of how it ends. */
        if (previous.state === "running" && pidAlive(previous.pid)) {
            logger.warn({ ownerPid: previous.pid, logsDir }, "another live daemon owns this history root — leaving its boot marker alone");
            return { markExited: () => undefined };
        }
        if (previous.state === "running") {
            const reports = fatalReports(logsDir, previous.pid);
            logger.error(
                {
                    // Not `pid` — that key is the logger's own base field (THIS process), and the collision
                    // would silently relabel the dead run's pid as the live one's.
                    diedPid: previous.pid,
                    startedAt: new Date(previous.startedAt).toISOString(),
                    ...(reports.length > 0 ? { fatalReports: reports } : {}),
                },
                reports.length > 0
                    ? "the previous daemon run died on a fatal error — read the named report for the cause"
                    : "the previous daemon run was killed without warning (SIGKILL, an OOM kill, or a forced container stop)",
            );
        }
    } catch {
        // First boot, or an unreadable marker — nothing to report either way.
    }
    const write = (marker: ExitMarker): void => {
        try {
            mkdirSync(logsDir, { recursive: true });
            writeFileSync(path, JSON.stringify(marker));
        } catch {
            // Best-effort by design.
        }
    };
    const startedAt = Date.now();
    write({ state: "running", pid: process.pid, startedAt });
    return {
        markExited: (code) => write({ state: "exited", pid: process.pid, startedAt, endedAt: Date.now(), exitCode: code }),
    };
};
