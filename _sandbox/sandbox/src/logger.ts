import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type DestinationStream, type Logger, type LoggerOptions, destination, multistream, pino, stdSerializers, stdTimeFunctions } from "pino";
import type { Config } from "./env.config.js";

// One config for every logger built here (base pid, ISO timestamps, `message` as message key) so lines from any sink
// parse and sort together. JSON unless logPretty is set (dev).
const loggerOptions = (config: Pick<Config, "logLevel">): LoggerOptions => ({
    base: { pid: process.pid },
    level: config.logLevel,
    messageKey: "message",
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: stdSerializers.err },
    timestamp: stdTimeFunctions.isoTime,
});

// Log file under historyRoot/logs, or undefined when historyRoot is empty or unwritable (dev, tests). pruneLogFiles
// owns retention; this creates none.
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

// Perf spans (historyRoot/logs/perf.jsonl) get their own file so daemon.log stays readable for actual errors. Undefined
// when there is no writable historyRoot; callers fall back to the main logger.
export const createPerfLogger = (config: Pick<Config, "logLevel" | "logPretty" | "historyRoot">): Logger | undefined => {
    if (config.logPretty) {
        // Dev reads one pretty stream; a second file nobody is tailing would only hide the spans.
        return undefined;
    }
    const file = logFile(config.historyRoot, "perf.jsonl");
    return file === undefined ? undefined : pino(loggerOptions(config), file);
};

// Browser-reported lines, kept out of daemon.log which is otherwise all daemon-authored. Fixed at `warn` regardless of
// the daemon's logLevel, so stall reports are not dropped; undefined means the route records nothing.
export const createClientLogger = (config: Pick<Config, "historyRoot">): Logger | undefined => {
    const file = logFile(config.historyRoot, "client.jsonl");
    return file === undefined ? undefined : pino(loggerOptions({ logLevel: "warn" }), file);
};

export const createLogger = (config: Pick<Config, "logLevel" | "logPretty" | "historyRoot">): Logger => {
    const options = loggerOptions(config);
    if (config.logPretty) {
        return pino({ ...options, transport: { target: "pino-pretty" } });
    }
    // JSON lines go to both stdout and historyRoot/logs/daemon.log: `docker logs` dies with the container, the volume
    // survives; GET /logs/file serves the tail. Falls back to stdout only when historyRoot is unwritable.
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
