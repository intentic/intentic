import type { ClientDiagnostic } from "@intentic/sandbox-contract";
import { buildId } from "./buildEpoch";
import { sandboxAuthenticatedFetch } from "./sandbox/sandboxAuthFetch";
import { currentSandboxTarget } from "./sandbox/sandboxTarget";

/* WHAT THE BROWSER SAW, SENT SOMEWHERE IT SURVIVES.
 *
 * Everything this app measured or caught used to end at the console. perf.ts warns about a stall into a ring
 * buffer that dies on reload; Vue's errorHandler logs a render error and stops; selfHeal.ts, on a startup
 * crash, CLEARS this origin's storage and reloads, destroying the evidence for the one class of bug that
 * reproduces least often. All of that is fine for whoever happens to be sitting in front of devtools at the
 * moment it happens, and nothing at all for everyone else, which in practice is everyone.
 *
 * What that cost, measured over 728 sessions: 1,545 screenshots against 65 reads of a console, and a quarter of
 * all prompts arriving with a picture attached because the user had no other way to show the app its own bug.
 * The editor is 943 files with zero logging calls in them, and it is also, by the transcripts' own count, the
 * second-buggiest package in the workspace. Those two facts are the same fact.
 *
 * So this posts to the daemon, which appends to logs/client.jsonl beside its own records, where the diagnostic
 * tools can read it.
 *
 * THREE RULES, in priority order, because a diagnostic channel that misbehaves is worse than none:
 *
 *  1. It never throws. Every entry point swallows, because the callers are an error handler, an unload hook and
 *     a perf recorder, and a reporter that fails inside those turns a bug into two bugs.
 *  2. It never blocks. Batched on a timer, fire-and-forget, and capped: a component looping on a render error
 *     produces thousands of identical events a second, so identical ones coalesce and the queue has a ceiling.
 *  3. It is never the reason something breaks. No await on any UI path, no retry, and a failed post drops the
 *     batch rather than growing a queue nobody is draining.
 *
 * NOT ANALYTICS. PostHog owns product events (analytics.ts). This carries only what a person cannot describe
 * and a screenshot cannot show: errors the app caught, recoveries it performed, and stalls it measured. */

// How long events wait for company. Long enough to coalesce a burst into one request, short enough that a user
// who reloads a few seconds after a crash has already sent it.
const FLUSH_MS = 5_000;

/* The queue ceiling, and it is a DROP rather than a backpressure. The failure this exists for is a component
 * that re-renders and re-throws in a loop: at that point the interesting information is the first few events
 * and the count, and every event after that is the same event. Matches the schema's own batch cap. */
const MAX_QUEUED = 50;

// How many times one (event, message) pair is sent per session before it is only counted. The first tells you
// what broke; the four-hundredth tells you nothing the count does not.
const MAX_PER_KIND = 5;

const queue: ClientDiagnostic[] = [];
const seen = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let dropped = 0;

// Where the user was standing. The single most useful field for reproducing anything, and read off `location`
// rather than the router so this module never depends on the thing that may be what crashed.
const route = (): string | undefined => {
    try {
        return `${location.pathname}${location.search}`.slice(0, 300);
    } catch {
        return undefined;
    }
};

/* Post whatever is queued. `keepalive` is the load-bearing detail rather than a nicety: the two moments most
 * worth reporting are a startup crash about to wipe-and-reload and a tab being closed, and an ordinary fetch
 * issued on either is cancelled with the page. keepalive survives it. sendBeacon would too and cannot carry the
 * daemon's bearer header, which this route requires.
 *
 * Drops on failure. A diagnostic queue that retries is a queue that grows while the thing it is describing is
 * still going wrong.
 *
 * Deliberately NOT through the typed daemon client: that one wraps every call in `trackPerf`, so a slow report
 * would file a slow span, which would queue a report, which would post again. Reaching for the shared fetch
 * policy directly keeps the credentials and the retry-on-401 and leaves the measurement out of the loop. */
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
            // Reporting is never worth interrupting anyone for. If this browser has no credential in hand the
            // report is lost, which is the same outcome as an unaddressed sandbox above, and strictly better
            // than a sign-in gate raised by the error handler that was describing the last thing that broke.
            { background: true },
        ).catch(() => undefined);
    } catch {
        // Unaddressed, unauthenticated, or a body that would not serialize. All of them mean this report is
        // lost, and none of them is worth telling the user about.
    }
};

/** Report something the browser saw. Safe to call from an error handler: it cannot throw and does not await. */
export const reportClient = (
    event: string,
    message: string,
    options: { level?: "warn" | "error"; fields?: Record<string, string | number | boolean>; requestId?: string } = {},
): void => {
    try {
        // `\u0000` as the escape, never as the byte: a literal NUL in the source makes git, grep and every diff
        // viewer read this file as binary (the repo's own `pnpm check:bytes` refuses it). Separator rather than
        // a join on some punctuation because it is the one character an event name or a message cannot contain.
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

/* An error's own words, shortened to what a log line can carry. The stack rather than the message alone,
 * because a render error's message ("Cannot read properties of undefined") names nothing at all, and the first
 * few frames are the entire difference between a report and a shrug. */
export const describeError = (error: unknown): { message: string; fields: Record<string, string> } => {
    if (error instanceof Error) {
        return {
            message: `${error.name}: ${error.message}`.slice(0, 2_000),
            ...(error.stack !== undefined ? { fields: { stack: error.stack.slice(0, 4_000) } } : { fields: {} }),
        };
    }
    return { message: String(error).slice(0, 2_000), fields: {} };
};

/* Wire the browser's own failure events. Called once at boot, alongside installSelfHeal.
 *
 * `error` and `unhandledrejection` are BOTH reported here, though selfHeal deliberately only heals on the
 * first: a rejection in the opening seconds is legitimately routine (a daemon asleep behind its tunnel), which
 * makes it a bad reason to wipe storage and a perfectly good thing to have written down.
 *
 * pagehide, not beforeunload/unload: it is the one that fires on mobile Safari's back-forward cache, which is
 * where a closed tab actually goes. */
export const installClientDiagnostics = (): void => {
    window.addEventListener(`error`, (event) => {
        // Resource-load and cross-origin events carry no Error and name nothing; a line saying "Script error"
        // with no file and no stack is not worth a round trip.
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
