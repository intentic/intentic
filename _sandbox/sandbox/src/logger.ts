import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type DestinationStream, type Logger, type LoggerOptions, destination, multistream, pino, stdSerializers, stdTimeFunctions } from "pino";
import type { Config } from "./env.config.js";

// The sandbox's structured logger. Config mirrors web-platform's pino setup (base pid, ISO timestamps, the
// `level` label formatter, the std error serializer, `message` as the message key), minus its NestJS /
// OpenTelemetry coupling. JSON by default; pino-pretty transport only when logPretty is set (dev), so the
// container still emits machine-readable lines.
// One shape for every logger this module makes, so a line from the perf sink and a line from daemon.log parse
// with the same reader and sort on the same timestamp.
const loggerOptions = (config: Pick<Config, "logLevel">): LoggerOptions => ({
    base: { pid: process.pid },
    level: config.logLevel,
    messageKey: "message",
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: stdSerializers.err },
    timestamp: stdTimeFunctions.isoTime,
});

// A writable log file under historyRoot/logs, or undefined when there is nowhere to put one: an unwritable
// historyRoot (local dev, tests) or the explicit empty-string opt-out. The hourly pruneLogFiles sweep caps
// whatever lands here, so a new file needs no retention of its own.
const logFile = (historyRoot: string, name: string): DestinationStream | undefined => {
    if (historyRoot === "") {
        return undefined;
    }
    try {
        mkdirSync(join(historyRoot, "logs"), { recursive: true });
        return destination(join(historyRoot, "logs", name));
    } catch {
        return undefined;
    }
};

/* THE PERF SINK (historyRoot/logs/perf.jsonl), a log of its own so that daemon.log can be read.
 *
 * Slow spans used to warn into daemon.log, one line each, and they buried it: of 5,465 warnings in a live 3.5MB
 * file, roughly 4,700 were four recurring `slow` ops, against six errors in the whole log. That is not a log
 * with noise in it, it is a log whose signal cannot be found, and the six errors were the ones a person was
 * looking for.
 *
 * Splitting the file rather than dropping the lines or raising the floors, because the lines are right and the
 * floors are honest: a `git.run` past 200ms on a machine at load 19 IS worth recording, it is simply not a
 * defect report, and the two things want different files. Same format, same timestamps, so an incident is still
 * one `sort` away from a merged timeline. The ranked summary stays in daemon.log, where somebody reading about
 * an incident will actually meet it.
 *
 * Undefined when there is no writable historyRoot, and the tracker then falls back to the main logger, which is
 * the current behaviour and the right one for a dev run with no /history volume. */
export const createPerfLogger = (config: Pick<Config, "logLevel" | "logPretty" | "historyRoot">): Logger | undefined => {
    if (config.logPretty) {
        // Dev reads one pretty stream; a second file nobody is tailing would only hide the spans.
        return undefined;
    }
    const file = logFile(config.historyRoot, "perf.jsonl");
    return file === undefined ? undefined : pino(loggerOptions(config), file);
};

export const createLogger = (config: Pick<Config, "logLevel" | "logPretty" | "historyRoot">): Logger => {
    const options = loggerOptions(config);
    if (config.logPretty) {
        return pino({ ...options, transport: { target: "pino-pretty" } });
    }
    // JSON lines go to stdout AND historyRoot/logs/daemon.log: `docker logs` dies with the container (a
    // capability rebuild `docker rm -f`s it) while the /history volume survives. GET /logs/file serves the
    // tail. Best-effort: an unwritable historyRoot (local dev, tests) means stdout only, and empty historyRoot
    // is the explicit opt-out. The hourly pruneLogFiles sweep caps the file's size.
    const file = logFile(config.historyRoot, "daemon.log");
    if (file === undefined) {
        return pino(options);
    }
    return pino(
        options,
        multistream([
            { level: config.logLevel, stream: process.stdout },
            { level: config.logLevel, stream: file },
        ]),
    );
};
