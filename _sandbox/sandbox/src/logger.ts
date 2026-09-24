import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type DestinationStream, type Logger, type LoggerOptions, destination, multistream, pino, stdSerializers, stdTimeFunctions } from "pino";
import type { Config } from "./env.config.js";

// What a log line was written on behalf of: the conversation whose turn or the browser request whose handler was running.
export interface LogContext {
    readonly conversationId?: string;
    readonly requestId?: string;
}

// Ambient, not explicit: work a turn or request merely started (a lazily armed timer) inherits it, so it names who was
// running, never who owns the line.
export const logContext = new AsyncLocalStorage<LogContext>();

// Every step of `source` runs inside `context`, since an async generator's body resumes in whoever calls next().
export async function* inLogContext<T>(context: LogContext, source: AsyncGenerator<T>): AsyncGenerator<T> {
    try {
        for (;;) {
            const step = await logContext.run(context, () => source.next());
            if (step.done === true) {
                return;
            }
            yield step.value;
        }
    } finally {
        await logContext.run(context, () => source.return(undefined));
    }
}

// One config for every logger built here (base pid, ISO timestamps, `message` as message key) so lines from any sink
// parse and sort together. JSON unless logPretty is set (dev).
export const loggerOptions = (config: Pick<Config, "logLevel">): LoggerOptions => ({
    base: { pid: process.pid },
    level: config.logLevel,
    messageKey: "message",
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: stdSerializers.err },
    timestamp: stdTimeFunctions.isoTime,
    mixin: () => {
        const context = logContext.getStore();
        return context === undefined ? {} : { ctx: context };
    },
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
