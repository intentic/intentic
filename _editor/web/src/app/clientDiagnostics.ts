import type { ClientDiagnostic, ClientPage } from "@intentic/sandbox-contract";
import { replaySessionId } from "./analytics";
import { buildId } from "./buildEpoch";
import { desktopApp } from "./environments/desktop";
import { lastFailedRequest } from "./perf";
import { t } from "@intentic/ui/i18n";
import { z } from "zod";

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

// Queue ceiling, matching the schema's own batch cap. A full queue sends at once rather than dropping, but at most this
// often: a component looping on re-render/re-throw must not turn into a request per frame.
const MAX_QUEUED = 50;
const EARLY_FLUSH_MS = 2_000;

// The first few copies of a kind go whole (with their stack); after that, copies are counted and said as one line with
// the count, at most this often, so a kind that keeps happening never goes silent and never floods.
const WHOLE_COPIES = 3;
const REPEAT_EVERY_MS = 60_000;
// A kind quiet this long is news again, and its next copy goes whole.
const FORGET_AFTER_MS = 10 * 60_000;
// Kinds remembered at once; a page producing more than this is already reporting plenty.
const MAX_KINDS = 300;

// How long a failed daemon call stays the likely cause of an error reported after it.
const FAILED_CALL_MS = 30_000;

/** What a report carries beyond its words, as the schema bounds it. */
export type ReportFields = NonNullable<ClientDiagnostic["fields"]>;

interface Kind {
    readonly event: string;
    level: "warn" | "error";
    // The newest copy's words, so a count line says what is still happening.
    message: string;
    // Copies since the kind was last news.
    count: number;
    // Copies not yet said.
    unsaid: number;
    lastAt: number;
    // Where the newest copy happened, which by the time its count is said may no longer be where the page is.
    route: string | undefined;
}

const queue: ClientDiagnostic[] = [];
const kinds = new Map<string, Kind>();
// Dropped from a full queue, by event name, so the line that admits it can say what was lost.
const dropped = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let repeatTimer: ReturnType<typeof setTimeout> | undefined;
let lastFlushAt = Number.NEGATIVE_INFINITY;

// Never the reason a test runner or a headless page stays alive.
const unref = (handle: ReturnType<typeof setTimeout>): void => (handle as unknown as { unref?: () => void }).unref?.();

// Where the user was, the single most useful field for reproducing anything. Reads `location` directly, not the
// router, so this doesn't depend on the thing that may have crashed.
const route = (): string | undefined => {
    try {
        return `${location.pathname}${location.search}`.slice(0, 300);
    } catch {
        return undefined;
    }
};

// What makes two copies the same kind: the message with what varies between copies of one fault (an address, an id,
// a count) taken out, since one varying id per copy otherwise made every copy news.
export const kindOf = (event: string, message: string): string => {
    const words = message
        .slice(0, 500)
        .replace(/\b[a-z][a-z\d+.-]*:\/\/\S+/giu, `<url>`)
        .replace(/\d+/gu, `#`)
        // A token still long once its numbers are folded is an id (a uuid, a hash, `conv_1a2b3c`); a short one is a
        // number with its unit (`48ms`), which the fold alone already made one kind.
        .replace(/[\w#-]*#[\w#-]*/gu, (token) => (token.length >= 6 ? `<id>` : token))
        .slice(0, 200);
    // `\u0000` is the JS escape, never a literal byte, which would make this file read as binary to git/grep/diffs.
    // Used as separator since it's the one character an event or message can't contain.
    return `${event}\u0000${words}`;
};

// ---- The page a batch comes from ----

// `getRandomValues`, not `randomUUID`: the latter is undefined on plain http (a self-hosted LAN instance).
const randomId = (): string => [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, `0`)).join(``);

// One per page load: what tells two tabs' reports, or a report from before a reload and after it, apart.
const pageId = randomId();

// One per tab, surviving its reloads: sessionStorage is per tab.
const TAB_KEY = `intentic.tab`;
const tabId = ((): string | undefined => {
    try {
        const known = sessionStorage.getItem(TAB_KEY);
        if (known !== null) {
            return known;
        }
        const fresh = randomId();
        sessionStorage.setItem(TAB_KEY, fresh);
        return fresh;
        // allow(silent-catch): storage off (private mode, site data blocked); the page id still tells the load apart
    } catch {
        return undefined;
    }
})();

// posthog-js's own record of the session, `$sesid: [lastActivity, sessionId, startedAt]`.
const PosthogSessionSchema = z.object({ $sesid: z.tuple([z.unknown(), z.string()]).rest(z.unknown()) });

// PostHog's session id, the key its replay is found by: asked of the SDK once it has loaded (replaySessionId), else read
// from where posthog-js keeps it, since the SDK loads at the page's first idle moment (analytics.ts) and an error report
// must not pull it in: with `persistence: sessionStorage` it lives under `ph_<key>_posthog` as `$sesid: [lastActivity,
// sessionId, startedAt]`.
const replayId = (): string | undefined => {
    const live = replaySessionId();
    if (live !== undefined && live !== ``) {
        return live.slice(0, 100);
    }
    try {
        for (let index = 0; index < sessionStorage.length; index++) {
            const key = sessionStorage.key(index);
            if (key === null || !key.startsWith(`ph_`) || !key.endsWith(`_posthog`)) {
                continue;
            }
            const stored = PosthogSessionSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? `{}`));
            if (stored.success) {
                return stored.data.$sesid[1].slice(0, 100);
            }
        }
        // allow(silent-catch): storage off, or a record this build cannot parse; the report goes without the join
    } catch {
        // Storage off, or a shape this build does not know: the report goes without the join.
    }
    return undefined;
};

// How the page was served, the first question about any report: an agent once spent dozens of calls learning a page
// came from the owner's own dev server rather than the build it had just changed.
const served = (): string => {
    const dev = import.meta.env.DEV_SOURCE;
    if (dev !== undefined) {
        return `dev ${dev.root}@${dev.branch ?? `?`}${dev.startedBy !== null ? ` by ${dev.startedBy}` : ``} since ${dev.startedAt}`.slice(0, 300);
    }
    if (import.meta.env.DEV) {
        return `dev`;
    }
    const app = desktopApp();
    return app !== undefined ? `desktop ${app.version}` : `hosted`;
};

/** The page this load reports as, said once per batch. Read at each flush, since the window and the replay change. */
export const clientPage = (): ClientPage => {
    const page: ClientPage = {
        pageId,
        userAgent: navigator.userAgent.slice(0, 300),
        viewport: `${innerWidth}x${innerHeight}@${Math.round(devicePixelRatio * 100) / 100}`,
        origin: location.origin.slice(0, 200),
        served: served(),
    };
    // Which code the page ran, beside how it was served: two pages served the same way can be builds apart.
    const commit = import.meta.env.BUILD_COMMIT;
    if (commit !== undefined && commit !== null && commit !== ``) {
        page.commit = commit.slice(0, 40);
    }
    if (tabId !== undefined) {
        page.tabId = tabId;
    }
    const replay = replayId();
    if (replay !== undefined) {
        page.replay = replay;
    }
    return page;
};

// Who carries a batch to the daemon (client/sandbox/clientReport.ts), handed in at boot (main.ts) since the daemon's
// client sits above this module. Until then, or with no sandbox addressed, a batch is dropped: nothing to report to.
type Sender = (events: readonly ClientDiagnostic[], page: ClientPage) => void;
let post: Sender | undefined;
export const sendClientDiagnosticsWith = (send: Sender): void => {
    post = send;
};

// ---- Queue and flush ----

// "perf.slow×8, vue.render×4": the top few names, so a dropped burst still says what it was.
const droppedKinds = (): string =>
    [...dropped.entries()]
        .toSorted(([, left], [, right]) => right - left)
        .slice(0, 5)
        .map(([event, count]) => `${event}×${count}`)
        .join(`, `);

// Drops on failure rather than retrying: the sender never throws back, and a report that cannot go is lost.
const flush = (): void => {
    if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
    }
    if (queue.length === 0) {
        return;
    }
    lastFlushAt = Date.now();
    const lost = [...dropped.values()].reduce((sum, count) => sum + count, 0);
    // Room left for the line admitting a loss: one over the schema's cap and the daemon refuses the whole batch.
    const events = queue.splice(0, lost > 0 ? MAX_QUEUED - 1 : MAX_QUEUED);
    if (queue.length > 0) {
        timer = setTimeout(flush, FLUSH_MS);
        unref(timer);
    }
    if (lost > 0) {
        // Say what was thrown away rather than letting a truncated picture read as a complete one.
        events.push({
            seenAt: Date.now(),
            level: `warn`,
            event: `client.dropped`,
            message: t(`app.clientDiagnostics.furtherReportsDroppedBy`, { dropped: lost }),
            build: buildId(),
            fields: { dropped: lost, kinds: droppedKinds() },
        });
        dropped.clear();
    }
    try {
        post?.(events, clientPage());
    } catch {
        // Unaddressed, unauthenticated, unserializable, or no window to describe — all mean the report is lost, none
        // worth surfacing to the user.
    }
};

// Into the queue, stamped with build and (unless it carries its own) route; a full queue sends now if it has not just
// sent, and drops otherwise.
const enqueue = (entry: Omit<ClientDiagnostic, "build">): void => {
    if (queue.length >= MAX_QUEUED) {
        if (Date.now() - lastFlushAt < EARLY_FLUSH_MS) {
            dropped.set(entry.event, (dropped.get(entry.event) ?? 0) + 1);
            return;
        }
        flush();
    }
    const stamped: ClientDiagnostic = { ...entry, build: buildId() };
    const here = entry.route ?? route();
    if (here !== undefined) {
        stamped.route = here;
    }
    queue.push(stamped);
    if (timer === undefined) {
        timer = setTimeout(flush, FLUSH_MS);
        unref(timer);
    }
};

// Each kind with copies not yet said, as one line carrying the count. Bypasses the kind check: it IS the count.
const sayRepeats = (): void => {
    if (repeatTimer !== undefined) {
        clearTimeout(repeatTimer);
        repeatTimer = undefined;
    }
    for (const kind of kinds.values()) {
        if (kind.unsaid === 0) {
            continue;
        }
        // Carries where the newest copy happened (enqueue fills in the current route only where this has none).
        const line: Omit<ClientDiagnostic, "build"> = {
            seenAt: kind.lastAt,
            level: kind.level,
            event: kind.event,
            message: kind.message,
            // `repeat` counts every copy since the kind was news, `unsaid` the ones this line is the only record of.
            fields: { repeat: kind.count, unsaid: kind.unsaid },
        };
        if (kind.route !== undefined) {
            line.route = kind.route;
        }
        enqueue(line);
        kind.unsaid = 0;
    }
};

// Forgets kinds gone quiet, and the oldest beyond the cap, so the memory is bounded and a quiet kind is news again.
const forget = (now: number): void => {
    for (const [key, kind] of kinds) {
        if (now - kind.lastAt > FORGET_AFTER_MS && kind.unsaid === 0) {
            kinds.delete(key);
        }
    }
    for (const key of kinds.keys()) {
        if (kinds.size <= MAX_KINDS) {
            break;
        }
        kinds.delete(key);
    }
};

// What an error report carries about the newest daemon call that failed just before it: not proof the call caused it,
// but the id that finds the daemon's own line for that call.
const addFailedCall = (fields: ReportFields): void => {
    const failed = lastFailedRequest(FAILED_CALL_MS);
    if (failed === undefined) {
        return;
    }
    fields[`lastFailedRequestId`] = failed.requestId;
    fields[`lastFailedOutcome`] = failed.outcome;
    fields[`lastFailedAgoMs`] = Date.now() - failed.at;
    if (failed.path !== undefined) {
        fields[`lastFailedPath`] = failed.path;
    }
};

/** Report something the browser saw. Safe to call from an error handler: it cannot throw and does not await. */
export const reportClient = (
    event: string,
    message: string,
    options: { level?: "warn" | "error"; fields?: Record<string, string | number | boolean>; requestId?: string } = {},
): void => {
    try {
        const now = Date.now();
        const level = options.level ?? `error`;
        const key = kindOf(event, message);
        let kind = kinds.get(key);
        if (kind !== undefined && now - kind.lastAt > FORGET_AFTER_MS && kind.unsaid === 0) {
            kinds.delete(key);
            kind = undefined;
        }
        if (kind === undefined) {
            forget(now);
            kind = { event: event.slice(0, 100), level, message: message.slice(0, 2_000), count: 0, unsaid: 0, lastAt: now, route: undefined };
            kinds.set(key, kind);
        }
        kind.count += 1;
        kind.lastAt = now;
        kind.message = message.slice(0, 2_000);
        kind.level = level;
        kind.route = route();
        if (kind.count > WHOLE_COPIES) {
            kind.unsaid += 1;
            if (repeatTimer === undefined) {
                repeatTimer = setTimeout(() => {
                    repeatTimer = undefined;
                    sayRepeats();
                }, REPEAT_EVERY_MS);
                unref(repeatTimer);
            }
            return;
        }
        const fields: ReportFields = { ...options.fields };
        if (level === `error` && options.requestId === undefined) {
            addFailedCall(fields);
        }
        // `repeat` only once it means something: a 1 on every line is noise, a 3 is a pattern.
        if (kind.count > 1) {
            fields[`repeat`] = kind.count;
        }
        const line: Omit<ClientDiagnostic, "build"> = { seenAt: now, level, event: event.slice(0, 100), message: message.slice(0, 2_000) };
        if (kind.route !== undefined) {
            line.route = kind.route;
        }
        if (options.requestId !== undefined) {
            line.requestId = options.requestId;
        }
        if (Object.keys(fields).length > 0) {
            line.fields = fields;
        }
        enqueue(line);
    } catch {
        // Reporting must never be the thing that fails.
    }
};

/** Send what is queued right now, for a caller about to destroy the page (a wipe-and-reload, a closing tab). */
export const flushClientDiagnostics = (): void => {
    sayRepeats();
    flush();
};

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

// A failed script or stylesheet, by its address without the query (which can carry a token). Images and media are left
// out: a broken avatar is not a fault worth a line, a chunk that never loaded is.
const failedResource = (target: EventTarget | null): { tag: string; url: string } | undefined => {
    if (target instanceof HTMLScriptElement && target.src !== ``) {
        return { tag: `script`, url: target.src.split(`?`)[0] ?? `` };
    }
    if (target instanceof HTMLLinkElement && target.href !== ``) {
        return { tag: `link`, url: target.href.split(`?`)[0] ?? `` };
    }
    return undefined;
};

// The browser's `error` event: a thrown Error, an error with no Error behind it (a cross-origin script's bare
// "Script error.", a worker's message), or, seen only while capturing, a script or stylesheet that failed to load.
export const reportWindowError = (event: Event): void => {
    if (event instanceof ErrorEvent) {
        if (event.error instanceof Error) {
            const { message, fields } = describeError(event.error);
            reportClient(`window.error`, message, { fields });
            return;
        }
        // No stack to keep, so where it came from is all there is.
        const fields: ReportFields = { noErrorObject: true };
        if (event.filename !== ``) {
            fields[`filename`] = event.filename.slice(0, 500);
        }
        if (event.lineno > 0) {
            fields[`line`] = event.lineno;
            fields[`column`] = event.colno;
        }
        reportClient(`window.error`, event.message === `` ? `error event with no message` : event.message, { fields });
        return;
    }
    const resource = failedResource(event.target);
    if (resource !== undefined) {
        reportClient(`resource.error`, `${resource.tag} failed to load: ${resource.url}`.slice(0, 2_000), { level: `warn`, fields: resource });
    }
};

// Wires the browser's own failure events, once at boot alongside installSelfHeal. Both `error` and
// `unhandledrejection` are reported, even though selfHeal only heals on `error`: an early rejection (a daemon still
// waking) is routine enough to log but not to wipe storage for. The `error` listener captures, since a resource's load
// failure does not bubble to the window. Uses `pagehide`, not beforeunload/unload, since that's what fires on mobile
// Safari's back-forward cache.
export const installClientDiagnostics = (): void => {
    window.addEventListener(`error`, reportWindowError, { capture: true });
    window.addEventListener(`unhandledrejection`, (event) => {
        const { message, fields } = describeError(event.reason);
        reportClient(`unhandled.rejection`, message, { fields });
    });
    window.addEventListener(`pagehide`, () => flushClientDiagnostics());
};
