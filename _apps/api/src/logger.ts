import { trace } from "@opentelemetry/api";
import pino from "pino";
import pretty from "pino-pretty";
import type { Config } from "./config.js";


// Correlate logs with traces (OTel standard): stamp every record with the active span's ids. No-op when there
// is no active span (tracing disabled or outside a request), so it's always safe to run.
const otelTraceContext = (): Record<string, string> => {
    const span = trace.getActiveSpan();
    if (!span) {
        return {};
    }
    const ctx = span.spanContext();
    return { trace_id: ctx.traceId, span_id: ctx.spanId, trace_flags: ctx.traceFlags.toString(16).padStart(2, `0`) };
};

// Root pino logger, fed by the typed config (level + pretty). Mirrors the shared pino setup across the repos:
// ISO timestamps, `message` as the message key, the standard `err` serializer, and `redact` so common secret
// fields never reach the output even if a handler logs a raw header or body (defense-in-depth alongside the
// config-level mask() in log.ts).
const options: pino.LoggerOptions = {
    base: { pid: process.pid },
    messageKey: `message`,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level: (label: string) => ({ level: label }),
    },
    mixin: otelTraceContext,
    serializers: {
        err: pino.stdSerializers.err,
    },
    redact: {
        paths: [`*.authorization`, `*.cookie`, `*.password`, `*.token`, `*.secret`],
        censor: `[REDACTED]`,
    },
};

export const createLogger = (config: Config): pino.Logger => {
    const withLevel: pino.LoggerOptions = { ...options, level: config.log.level };
    // Dev: colorized, human-readable output via an in-process pino-pretty stream (no thread-stream worker, so
    // it's reliable under Bun). Prod: single-line JSON straight to stdout for log collectors.
    return config.log.pretty
        ? pino(withLevel, pretty({ colorize: true, messageKey: `message`, translateTime: `SYS:HH:MM:ss`, ignore: `pid,hostname` }))
        : pino(withLevel);
};
