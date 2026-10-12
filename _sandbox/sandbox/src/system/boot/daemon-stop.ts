import { errorMessage } from "@intentic/base/errors";
import type { DisposeOutcome } from "@intentic/base/lifecycle";
import type { Logger } from "pino";
import { opt } from "../../opt.js";
import { buildInfo, buildText } from "./build-info.js";
import { noteStop, writeRestartIntent } from "./boot-marker.js";
import { initiatorText, type ReadIntent, readRestartIntent, type RestartAction, spanOf, standingIntent } from "./restart-record.js";

// How long the daemon's teardown may run before the process exits anyway: well inside the 25 s netd gives a stopping
// daemon before its SIGKILL (netd's supervise.rs STOP_GRACE), so a stop that hangs costs this wait, never the kill.
export const STOP_DEADLINE_MS = 10_000;

// How the daemon exits when netd's control link drops without being asked to: EX_TEMPFAIL. netd starts again a daemon
// that exits with anything but 0 or 78 (its supervise.rs) and goes on running, where a 0 would end netd, and with it the
// container (on Fly, a machine left stopped) for what restarting Node alone recovers.
export const LINK_LOST_EXIT = 75;

// What the daemon tears down on its way out: every subsystem's stop, registered where it was started.
export interface Teardown {
    readonly disposeWithin: (deadlineMs: number) => Promise<DisposeOutcome>;
}

// Runs the teardown, newest first, under STOP_DEADLINE_MS and describes what did not stop cleanly: undefined when
// everything did. Never throws, since an exit follows it whatever happened.
export const tearDown = async (teardown: Teardown): Promise<string | undefined> => {
    const { failed, unfinished } = await teardown.disposeWithin(STOP_DEADLINE_MS);
    const problems = [
        ...failed.map((error) => (error instanceof Error ? error.message : String(error))),
        ...(unfinished > 0 ? [`${unfinished} still stopping after ${STOP_DEADLINE_MS} ms`] : []),
    ];
    return problems.length === 0 ? undefined : problems.join("; ");
};

// Why this stop: the signal that asked for it, or what the daemon itself is stopping for (written as the restart
// intent, restart-record.ts, so it reads like any other initiator's at the next boot).
export interface StopCause {
    readonly signal?: NodeJS.Signals;
    readonly action?: RestartAction;
    readonly reason?: string;
}

// A stop with no cause of its own, by its exit code.
const causeOfExit = (exitCode: number): StopCause | undefined =>
    exitCode === LINK_LOST_EXIT ? { action: "restart", reason: "intentic-netd closed the daemon's control link, so netd starts it again" } : undefined;

/**
 * Logs the stop that is starting, with its signal, its initiator (this daemon's own cause, else a restart intent written
 * since this process started), uptime and build, and notes it for the exit marker. Never throws.
 */
export const announceStop = (
    logger: Pick<Logger, "info" | "warn">,
    logsDir: string | undefined,
    exitCode: number,
    cause: StopCause | undefined,
    now: number = Date.now(),
): void => {
    const effective = cause ?? causeOfExit(exitCode);
    const startedAt = now - Math.round(process.uptime() * 1000);
    let intent: ReadIntent | undefined;
    if (logsDir !== undefined && effective?.action !== undefined && effective.reason !== undefined) {
        const own = { by: "daemon", action: effective.action, reason: effective.reason, at: new Date(now).toISOString() } as const;
        try {
            writeRestartIntent(logsDir, own);
        } catch (error) {
            // This line still names the cause; only the next boot reads the stop as unexplained.
            logger.warn({ reason: errorMessage(error) }, "shutdown: the restart intent could not be written");
        }
        intent = own;
    } else if (logsDir !== undefined) {
        intent = standingIntent(readRestartIntent(logsDir), startedAt, now);
    }
    const why = [
        ...(effective?.signal === undefined ? [] : [effective.signal]),
        intent === undefined ? (effective?.reason ?? (effective?.signal === undefined ? "asked from inside" : "no initiator recorded")) : initiatorText(intent),
    ].join(", ");
    const build = buildInfo();
    noteStop({ ...opt("signal", effective?.signal), reason: why });
    logger.info(
        {
            ...opt("signal", effective?.signal),
            ...opt("initiator", intent),
            exitCode,
            uptimeSeconds: Math.round(process.uptime()),
            build,
        },
        `shutting down intentic sandbox daemon… (${why}; up ${spanOf(Math.round(process.uptime()))}, ${buildText(build)})`,
    );
};
