import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { writeFileAtomicSync } from "@intentic/base/fs";
import type { Logger } from "pino";
import { opt } from "../../../opt.js";
import { processIdentity, type ProcessIdentity, sameProcess } from "../../resources/proc-stat.js";
import { buildInfo, buildText } from "../build-info.js";
import {
    describePreviousRun,
    type PreviousRun,
    previousRunOf,
    readRestartIntent,
    removeRestartIntent,
    RESTART_INTENT_FILE,
    type RestartIntent,
    type RestartRecord,
    RESTARTS_FILE,
    RESTARTS_KEPT,
} from "./restart-record.js";

// Marker file for whether the daemon exited cleanly. Boot writes "running" and any exit rewrites it synchronously, a
// deliberate stop with its signal and initiator; a marker still saying "running" at the next boot means the previous
// process was killed without warning. Read while a daemon is up, it says "running": that run. Each write replaces the
// file whole: a kill in the middle of one would otherwise leave a torn marker, which reads as a first boot and so hides
// exactly the death it is there to report.
// The host reads it too: `ic` takes `startedAt` off it to count a daemon's restarts (_sandbox/ic/src/sandbox/probation.rs)
// and reads nothing else, so fields can be added; held to this file's name and shape by system/host-files.test.ts.

export const MARKER_FILE = "daemon-exit.json";

export interface ExitMarker extends ProcessIdentity {
    readonly state: "running" | "exited";
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly exitCode?: number;
    // The build this run was (build-info.ts), so the next boot can say which one ended.
    readonly version?: string;
    readonly commit?: string;
    // PID 1's start, by which the next boot tells a daemon restart from a container restart.
    readonly containerStartTicks?: number;
    // Set on exit: whether the run went through the daemon's stop (daemon-stop.ts announceStop), the signal that asked
    // for it, and its initiator in words. An exit without the stop (an uncaught exception, a fatal boot) is not graceful.
    readonly graceful?: boolean;
    readonly signal?: string;
    readonly stopReason?: string;
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

// The one stop under way (daemon-stop.ts announceStop), for the exit marker to record: absent means the process ended
// without going through the stop, which the next boot reads as a crash.
export interface NotedStop {
    readonly signal?: string;
    readonly reason: string;
}

let noted: NotedStop | undefined;

export const noteStop = (stop: NotedStop): void => {
    noted = stop;
};

/** Test seam: forgets the noted stop. */
export const resetStopNoted = (): void => {
    noted = undefined;
};

// How the run before this one ended (restart-record.ts), for what tells an agent what a restart cost it.
let lastPrevious: PreviousRun | undefined;

/** How the run before this one ended, once this run claimed the marker; undefined for a daemon that did not. */
export const previousRun = (): PreviousRun | undefined => lastPrevious;

// Left in /tmp by every boot: a later boot that cannot find it knows /tmp was emptied since (a recreated container),
// which a restart that only restarted the container does not do.
const TMP_MARKER = join(tmpdir(), ".intentic-daemon-run");

export interface ClaimOptions {
    readonly now?: number;
    readonly tmpMarker?: string;
}

// Whether the container restarted since the previous run: its PID 1 is no longer the process it was.
const containerRestarted = (previous: ExitMarker | undefined): boolean | undefined =>
    previous?.containerStartTicks === undefined ? undefined : !sameProcess({ pid: 1, startTimeTicks: previous.containerStartTicks });

// Whether /tmp was emptied since the previous run; unknown on a first boot, and for a run from before the marker.
const tmpCleared = (previous: ExitMarker | undefined, tmpMarker: string): boolean | undefined => {
    if (previous?.containerStartTicks === undefined) {
        return undefined;
    }
    return !existsSync(tmpMarker);
};

const readMarker = (path: string): ExitMarker | undefined => {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as ExitMarker;
    } catch {
        // First boot, or an unreadable marker, nothing to report either way.
        return undefined;
    }
};

// Says how the previous run ended, in one line beside this run's build, and files it in restarts.jsonl; the intent
// left for that stop is spent here. Never throws.
const reportPreviousRun = (logsDir: string, logger: Logger, previous: ExitMarker | undefined, now: number, tmpMarker: string): void => {
    const reports = previous?.state === "running" ? fatalReports(logsDir, previous.pid) : [];
    const run = previousRunOf({
        marker: previous,
        intent: readRestartIntent(logsDir),
        now,
        fatalReports: reports,
        ...opt("containerRestarted", containerRestarted(previous)),
        ...opt("tmpCleared", tmpCleared(previous, tmpMarker)),
    });
    lastPrevious = run;
    previousDied = previous?.state === "running";
    const build = buildInfo();
    const fields = {
        build,
        previous: run,
        // Not `pid`, the logger's own base field names this process; reusing it would mislabel the dead run's pid.
        ...opt("diedPid", previousDied ? previous?.pid : undefined),
        ...opt("startedAt", previousDied && previous !== undefined ? new Date(previous.startedAt).toISOString() : undefined),
        ...opt("fatalReports", reports.length > 0 ? reports : undefined),
    };
    const message = `daemon ${buildText(build)} starting; previous run ended: ${describePreviousRun(run)}`;
    // A death nobody announced is the news; one an initiator announced first, or a stop that went wrong, is worth a look.
    if ((run.ended === "killed" || run.ended === "crashed") && run.intent === undefined) {
        logger.error(fields, message);
    } else if (run.ended === "killed" || run.ended === "crashed" || run.ended === "exited") {
        logger.warn(fields, message);
    } else {
        logger.info(fields, message);
    }
    try {
        mkdirSync(logsDir, { recursive: true });
        appendRestart(logsDir, { at: new Date(now).toISOString(), boot: { pid: process.pid, version: build.version, ...opt("commit", build.commit) }, previous: run });
        removeRestartIntent(logsDir);
    } catch (error) {
        // A history root that cannot be written still boots, as with the marker.
        logger.warn({ reason: errorMessage(error), logsDir }, "boot: this restart could not be filed in restarts.jsonl");
    }
};

// Reads the previous run's fate, says how it ended, and claims the marker for this run. Never throws: a sandbox that
// cannot write its marker still runs, just with worse forensics.
// `claimed`: this run took the marker, which is to say it owns the history root (a live daemon's left alone is not).
export const claimBootMarker = (
    logsDir: string,
    logger: Logger,
    options: ClaimOptions = {},
): { readonly claimed: boolean; readonly markExited: (code: number) => void } => {
    const path = join(logsDir, MARKER_FILE);
    const now = options.now ?? Date.now();
    const tmpMarker = options.tmpMarker ?? TMP_MARKER;
    const previous = readMarker(path);
    // Not a death: a live daemon owns this history root; leave its marker alone and claim nothing.
    if (previous?.state === "running" && sameProcess(previous)) {
        logger.warn({ ownerPid: previous.pid, logsDir }, "another live daemon owns this history root, leaving its boot marker alone");
        return { claimed: false, markExited: () => undefined };
    }
    reportPreviousRun(logsDir, logger, previous, now, tmpMarker);
    try {
        writeFileSync(tmpMarker, String(process.pid));
    } catch (error) {
        // Without it the next boot cannot tell whether /tmp was emptied, and says nothing about it.
        logger.debug({ reason: errorMessage(error), tmpMarker }, "boot: the /tmp marker could not be written");
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
        return { claimed: true, markExited: () => undefined };
    }
    const build = buildInfo();
    const running: ExitMarker = {
        state: "running",
        ...identity,
        startedAt: now,
        version: build.version,
        ...opt("commit", build.commit),
        ...opt("containerStartTicks", processIdentity(1)?.startTimeTicks),
    };
    write(running);
    return {
        claimed: true,
        markExited: (code) => {
            const stop = noted;
            write({
                ...running,
                state: "exited",
                endedAt: Date.now(),
                exitCode: code,
                graceful: stop !== undefined,
                ...opt("signal", stop?.signal),
                ...opt("stopReason", stop?.reason),
            });
        },
    };
};

/** Writes the intent, replacing any earlier one; synchronous, as a stop may follow at once. */
export const writeRestartIntent = (logsDir: string, intent: Omit<RestartIntent, "at"> & { readonly at?: string }): void => {
    mkdirSync(logsDir, { recursive: true });
    writeFileAtomicSync(join(logsDir, RESTART_INTENT_FILE), `${JSON.stringify({ ...intent, at: intent.at ?? new Date().toISOString() })}\n`);
};

/** Appends one boot's record, keeping the newest RESTARTS_KEPT. Synchronous, as the boot marker is. */
export const appendRestart = (logsDir: string, record: RestartRecord): void => {
    const path = join(logsDir, RESTARTS_FILE);
    let kept: string[] = [];
    try {
        kept = readFileSync(path, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .slice(-(RESTARTS_KEPT - 1));
    } catch (error) {
        // None yet is the first record; anything else is the caller's to report.
        undefinedIfMissing(error);
    }
    writeFileAtomicSync(path, `${[...kept, JSON.stringify(record)].join("\n")}\n`);
};
