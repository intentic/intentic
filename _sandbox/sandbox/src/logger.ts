import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type DestinationStream, type Logger, type LoggerOptions, destination, multistream, pino, stdSerializers, stdTimeFunctions } from "pino";
import type { Config } from "./env.config.js";

// The sandbox's structured logger. Config mirrors web-platform's pino setup (base pid, ISO timestamps, the
// `level` label formatter, the std error serializer, `message` as the message key), minus its NestJS /
// OpenTelemetry coupling. JSON by default; pino-pretty transport only when logPretty is set (dev), so the
// container still emits machine-readable lines.
export const createLogger = (config: Pick<Config, "logLevel" | "logPretty" | "historyRoot">): Logger => {
    const options: LoggerOptions = {
        base: { pid: process.pid },
        level: config.logLevel,
        messageKey: "message",
        formatters: { level: (label) => ({ level: label }) },
        serializers: { err: stdSerializers.err },
        timestamp: stdTimeFunctions.isoTime,
    };
    if (config.logPretty) {
        return pino({ ...options, transport: { target: "pino-pretty" } });
    }
    // JSON lines go to stdout AND historyRoot/logs/daemon.log: `docker logs` dies with the container (a
    // capability rebuild `docker rm -f`s it) while the /history volume survives — GET /logs/file serves the
    // tail. Best-effort: an unwritable historyRoot (local dev, tests) means stdout only, and empty historyRoot
    // is the explicit opt-out. The hourly pruneLogFiles sweep caps the file's size.
    const file = ((): DestinationStream | undefined => {
        if (config.historyRoot === "") {
            return undefined;
        }
        try {
            mkdirSync(join(config.historyRoot, "logs"), { recursive: true });
            return destination(join(config.historyRoot, "logs", "daemon.log"));
        } catch {
            return undefined;
        }
    })();
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
