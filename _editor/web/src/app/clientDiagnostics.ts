import type { ClientDiagnostic } from "@intentic/sandbox-contract";
import { buildId } from "./buildEpoch";
import { sandboxAuthenticatedFetch } from "../features/sandbox/client/sandboxAuthFetch";
import { currentSandboxTarget } from "../features/sandbox/client/sandboxTarget";

// Posts what the browser saw or measured to the daemon (logs/client.jsonl beside its own records), since
// console-only diagnostics (perf.ts's ring buffer, Vue's errorHandler, selfHeal's wipe-and-reload) reach only
// whoever has devtools open at that moment.
//
// Three rules, since a diagnostic channel that misbehaves is worse than none:
// 1. Never throws — callers are an error handler, an unload hook, a perf recorder.
// 2. Never blocks — batched, fire-and-forget, capped.
// 3. Never itself the reason something breaks — no await on a UI path, no retry, drops rather than growing a queue.
//
// Not analytics (PostHog owns product events, analytics.ts); this carries only what a screenshot can't show.

// How long events wait to batch: long enough to coalesce a burst, short enough to have sent before a quick reload.
const FLUSH_MS = 5_000;

// Queue ceiling is a drop, not backpressure, for a component looping on re-render/re-throw; matches the schema's
// own batch cap.
const MAX_QUEUED = 50;

// Per-(event,message) cap before further copies are only counted; the first occurrence informs, repeats don't.
const MAX_PER_KIND = 5;

const queue: ClientDiagnostic[] = [];
const seen = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let dropped = 0;

// Where the user was, the single most useful field for reproducing anything. Reads `location` directly, not the
// router, so this doesn't depend on the thing that may have crashed.
const route = (): string | undefined => {
    try {
        return `${location.pathname}${location.search}`.slice(0, 300);
    } catch {
        return undefined;
    }
};

// `keepalive` is load-bearing: a startup crash or a closing tab cancels an ordinary fetch with the page, but not a
// keepalive one; `sendBeacon` would survive too but can't carry the daemon's bearer header. Drops on failure rather
// than retrying. Deliberately not through the typed daemon client: that wraps calls in `trackPerf`, which would
// make a slow report file a slow span that queues another report.
const flush = (): void => {
    if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
    }
    if (queue.length === 0) {
        return;
    }
    const events = queue.splice(0, MAX_QUEUED);
    if (dropped > 0) {
        // Say what was thrown away rather than letting a truncated picture read as a complete one.
        events.push({
            seenAt: Date.now(),
            level: "warn",
            event: `client.dropped`,
            message: `${dropped} further reports were dropped by the client's own cap.`,
            build: buildId(),
        });
        dropped = 0;
    }
    try {
        const target = currentSandboxTarget();
        if (target === undefined) {
            // No sandbox addressed yet (the sign-in screens): nothing to report to, and nothing to keep either.
            return;
        }
        void sandboxAuthenticatedFetch(
            new Request(`${target.base}/logs/client`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ events }),
                keepalive: true,
            }),
            target,
            // Never worth interrupting anyone for: a missing credential just loses the report, which beats raising a
            // sign-in
            // gate from inside an error handler.
            { background: true },
        ).catch(() => undefined);
    } catch {
        // Unaddressed, unauthenticated, or unserializable — all mean the report is lost, none worth surfacing to the
        // user.
    }
};

/** Report something the browser saw. Safe to call from an error handler: it cannot throw and does not await. */
export const reportClient = (
    event: string,
    message: string,
    options: { level?: "warn" | "error"; fields?: Record<string, string | number | boolean>; requestId?: string } = {},
): void => {
    try {
        // `\u0000` is the JS escape, never a literal byte, which would make this file read as binary to git/grep/diffs.
        // Used as separator since it's the one character an event or message can't contain.
        const key = `${event}\u0000${message.slice(0, 200)}`;
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count > MAX_PER_KIND || queue.length >= MAX_QUEUED) {
            dropped += 1;
            return;
        }
        const here = route();
        queue.push({
            seenAt: Date.now(),
            level: options.level ?? `error`,
            event: event.slice(0, 100),
            message: message.slice(0, 2_000),
            ...(here !== undefined ? { route: here } : {}),
            ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
            build: buildId(),
            // `repeat` only once it means something: a 1 on every line is noise, a 4 is a pattern.
            ...(options.fields !== undefined || count > 1 ? { fields: { ...options.fields, ...(count > 1 ? { repeat: count } : {}) } } : {}),
        });
        if (timer === undefined) {
            timer = setTimeout(flush, FLUSH_MS);
            // Never the reason a test runner or a headless page stays alive.
            (timer as unknown as { unref?: () => void }).unref?.();
        }
    } catch {
        // Reporting must never be the thing that fails.
    }
};

/** Send what is queued right now, for a caller about to destroy the page (a wipe-and-reload, a closing tab). */
export const flushClientDiagnostics = (): void => flush();

// An error's words, shortened to fit a log line. Keeps the stack, not just the message: a message like "Cannot
// read properties of undefined" names nothing on its own.
export const describeError = (error: unknown): { message: string; fields: Record<string, string> } => {
    if (error instanceof Error) {
        return {
            message: `${error.name}: ${error.message}`.slice(0, 2_000),
            ...(error.stack !== undefined ? { fields: { stack: error.stack.slice(0, 4_000) } } : { fields: {} }),
        };
    }
    return { message: String(error).slice(0, 2_000), fields: {} };
};

// Wires the browser's own failure events, once at boot alongside installSelfHeal. Both `error` and
// `unhandledrejection` are reported, even though selfHeal only heals on `error`: an early rejection (a daemon still
// waking) is routine enough to log but not to wipe storage for. Uses `pagehide`, not beforeunload/unload, since
// that's what fires on mobile Safari's back-forward cache.
export const installClientDiagnostics = (): void => {
    window.addEventListener(`error`, (event) => {
        // Resource-load and cross-origin events carry no Error; a bare "Script error" with no stack isn't worth a round
        // trip.
        if (event.error instanceof Error) {
            const { message, fields } = describeError(event.error);
            reportClient(`window.error`, message, { fields });
        }
    });
    window.addEventListener(`unhandledrejection`, (event) => {
        const { message, fields } = describeError(event.reason);
        reportClient(`unhandled.rejection`, message, { fields });
    });
    window.addEventListener(`pagehide`, () => flush());
};
