import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "@intentic/base/fs";
import type { Logger } from "pino";
import { processIdentity, type ProcessIdentity, sameProcess } from "../resources/proc-stat.js";

// Marker file for whether the daemon exited cleanly. Boot writes "running" and a deliberate exit rewrites it
// synchronously; a marker still saying "running" at the next boot means the previous process was killed without
// warning. Each write replaces the file whole: a kill in the middle of one would otherwise leave a torn marker, which
// reads as a first boot and so hides exactly the death it is there to report.

const MARKER_FILE = "daemon-exit.json";

interface ExitMarker extends ProcessIdentity {
    readonly state: "running" | "exited";
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly exitCode?: number;
}

// Diagnostic reports --report-on-fatalerror writes next to the logs (report.<date>.<pid>.json) for a given pid.
const fatalReports = (dir: string, pid: number): string[] => {
    try {
        return readdirSync(dir).filter((name) => name.startsWith("report.") && name.endsWith(`.${pid}.0.json`));
    } catch {
        return [];
    }
};

// Whether this process found the previous run dead without its exit hook having run: set by claimBootMarker, read by
// what is worth checking only after such a death (the conversation database's integrity, conversations-db.ts).
let previousDied = false;

export const previousRunDied = (): boolean => previousDied;

// Reads the previous run's fate, logs it if it died unannounced, and claims the marker for this run. Never throws: a
// sandbox that cannot write its marker still runs, just with worse forensics.
export const claimBootMarker = (logsDir: string, logger: Logger): { markExited: (code: number) => void } => {
    const path = join(logsDir, MARKER_FILE);
    try {
        const previous = JSON.parse(readFileSync(path, "utf8")) as ExitMarker;
        // Not a death: a live daemon owns this history root; leave its marker alone and claim nothing.
        if (previous.state === "running" && sameProcess(previous)) {
            logger.warn({ ownerPid: previous.pid, logsDir }, "another live daemon owns this history root, leaving its boot marker alone");
            return { markExited: () => undefined };
        }
        if (previous.state === "running") {
            previousDied = true;
            const reports = fatalReports(logsDir, previous.pid);
            logger.error(
                {
                    // Not `pid`, the logger's own base field names this process; reusing it would mislabel the dead
                    // run's pid.
                    diedPid: previous.pid,
                    startedAt: new Date(previous.startedAt).toISOString(),
                    ...(reports.length > 0 ? { fatalReports: reports } : {}),
                },
                reports.length > 0
                    ? "the previous daemon run died on a fatal error: read the named report for the cause"
                    : "the previous daemon run was killed without warning (SIGKILL, an OOM kill, or a forced container stop)",
            );
        }
    } catch {
        // First boot, or an unreadable marker, nothing to report either way.
    }
    const write = (marker: ExitMarker): void => {
        try {
            mkdirSync(logsDir, { recursive: true });
            writeFileAtomicSync(path, JSON.stringify(marker));
        } catch {
            // Best-effort: a failed write is not surfaced.
        }
    };
    const identity = processIdentity();
    if (identity === undefined) {
        return { markExited: () => undefined };
    }
    const startedAt = Date.now();
    write({ state: "running", ...identity, startedAt });
    return {
        markExited: (code) => write({ state: "exited", ...identity, startedAt, endedAt: Date.now(), exitCode: code }),
    };
};
