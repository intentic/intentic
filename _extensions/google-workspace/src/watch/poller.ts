import { errorMessage } from "@intentic/base/errors";
import type { GatewayCtx, ListenerMessage } from "@intentic/connector-runtime";
import type { Connection } from "../google/accounts.js";
import { mapLimit } from "../google/batch.js";
import { type GmailMessage, addressOf, nameOf, parseMessage } from "../google/gmail-message.js";
import { workspaceRoot } from "../google/paths.js";
import { GoogleApiError, call } from "../google/request.js";
import type { Session } from "../google/session.js";
import { type Watermark, pruneAnnounced, readWatermark, watermarkPath, writeWatermark } from "./watermark.js";

// Watches a Google account by polling, since Gmail's push notifications need a public HTTPS endpoint a sandbox lacks.
// Mail rides Gmail's own `history.list` cursor, so any length of downtime is answered in one call. Calendar has no such
// cursor, so it's a window instead: list what starts soon, remember what's already announced.

export interface WatcherOptions {
    readonly mailIntervalMs?: number;
    readonly calendarIntervalMs?: number;
    readonly lookaheadMs?: number;
}

const MAIL_INTERVAL_MS = 60_000;
const CALENDAR_INTERVAL_MS = 120_000;
// How far ahead a meeting is announced: long enough to be useful, short enough to still be actionable.
const LOOKAHEAD_MS = 10 * 60_000;
// Announced events are kept an hour past their start, comfortably longer than any window that could resurface them.
const ANNOUNCED_KEEP_MS = 60 * 60_000;
const EXCERPT = 600;

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3";

interface HistoryPage {
    readonly history?: readonly {
        readonly messagesAdded?: readonly { readonly message?: { readonly id?: string; readonly labelIds?: string[] } }[];
    }[];
    readonly historyId?: string;
}

interface WatchedEvent {
    readonly id: string;
    readonly summary?: string;
    readonly location?: string;
    readonly htmlLink?: string;
    readonly hangoutLink?: string;
    readonly start?: { readonly dateTime?: string };
    readonly end?: { readonly dateTime?: string };
    readonly organizer?: { readonly email?: string };
    readonly attendees?: readonly { readonly email?: string; readonly responseStatus?: string }[];
}

// New INBOX message ids since a cursor, plus the cursor to store next. A 404 means Gmail aged the cursor out; the
// caller re-baselines.
export const newMessageIds = (pages: readonly HistoryPage[]): string[] => {
    const ids = new Set<string>();
    for (const page of pages) {
        for (const change of page.history ?? []) {
            for (const added of change.messagesAdded ?? []) {
                const message = added.message;
                if (message?.id !== undefined && (message.labelIds ?? []).includes("INBOX")) {
                    ids.add(message.id);
                }
            }
        }
    }
    return [...ids];
};

// Whether this account is an actual addressee rather than one of fifty on a list.
export const addressedTo = (email: string, to: string): boolean =>
    to
        .split(",")
        .map((entry) => addressOf(entry).toLowerCase())
        .includes(email.toLowerCase());

export interface Watcher {
    readonly stop: () => void;
    readonly alive: () => boolean;
}

export const startWatcher = (
    ctx: GatewayCtx,
    connection: Connection,
    session: Session,
    onFatal: (detail: string) => void,
    options: WatcherOptions = {},
): Watcher => {
    const path = watermarkPath(workspaceRoot(process.env, ctx.workspaceRoot), connection.name);
    let mark: Watermark = {};
    let running = true;
    let loaded = false;

    const save = async (next: Watermark): Promise<void> => {
        mark = next;
        await writeWatermark(path, mark);
    };

    // An auth failure won't come right on its own (dead refresh token, withdrawn delegation, narrowed scopes);
    // reporting it fatal stops this connection from repeating the same rejected question every minute.
    const guard = async (what: string, work: () => Promise<void>): Promise<void> => {
        try {
            await work();
        } catch (error) {
            const message = errorMessage(error);
            if (error instanceof GoogleApiError && (error.status === 401 || error.status === 403)) {
                onFatal(message);
                running = false;
                return;
            }
            ctx.log.warn({ err: error, account: connection.name }, `google ${what} poll failed`);
        }
    };

    const dispatchMail = async (ids: readonly string[]): Promise<void> => {
        const messages = await mapLimit(ids, 5, (id) =>
            call<GmailMessage>(session, {
                url: `${GMAIL}/messages/${encodeURIComponent(id)}`,
                query: { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] },
            }),
        );
        for (const raw of messages) {
            const message = parseMessage(raw);
            const event: ListenerMessage = {
                provider: "google",
                type: "mail",
                id: message.id,
                channelId: "INBOX",
                author: { id: addressOf(message.from), name: nameOf(message.from) },
                content: `${message.subject === "" ? "(no subject)" : message.subject}\n\n${(raw.snippet ?? message.text).slice(0, EXCERPT)}`,
                mentioned: addressedTo(connection.email, message.to),
                timestamp: new Date(Number(raw.internalDate ?? Date.now())).toISOString(),
                extra: {
                    account: connection.name,
                    messageId: message.id,
                    threadId: message.threadId,
                    from: message.from,
                    to: message.to,
                    subject: message.subject,
                    labels: message.labels,
                    attachments: message.attachments.map((attachment) => attachment.filename),
                },
            };
            await ctx.daemon.dispatch(event);
        }
    };

    const pollMail = async (): Promise<void> => {
        if (mark.historyId === undefined) {
            // First run, or an aged-out cursor: baseline and announce nothing, since older mail already had its chance.
            const profile = await call<{ historyId?: string }>(session, { url: `${GMAIL}/profile` });
            await save({ ...mark, ...(profile.historyId === undefined ? {} : { historyId: profile.historyId }) });
            return;
        }
        const pages: HistoryPage[] = [];
        let pageToken: string | undefined;
        let cursor = mark.historyId;
        do {
            const page = await call<HistoryPage & { nextPageToken?: string }>(session, {
                url: `${GMAIL}/history`,
                query: { startHistoryId: mark.historyId, historyTypes: "messageAdded", labelId: "INBOX", pageToken, maxResults: 500 },
            }).catch((error: unknown) => {
                if (error instanceof GoogleApiError && error.status === 404) {
                    return undefined;
                }
                throw error;
            });
            if (page === undefined) {
                ctx.log.info({ account: connection.name }, "gmail history cursor expired, re-baselining");
                // Dropped, not blanked: the next tick's no-cursor branch takes a fresh baseline from the account.
                await save(mark.announced === undefined ? {} : { announced: mark.announced });
                return;
            }
            pages.push(page);
            cursor = page.historyId ?? cursor;
            pageToken = page.nextPageToken;
        } while (pageToken !== undefined);
        const ids = newMessageIds(pages);
        // Advances before dispatching: a throw here must not replay the same mail next tick.
        await save({ ...mark, historyId: cursor });
        if (ids.length > 0) {
            await dispatchMail(ids);
        }
    };

    const pollCalendar = async (): Promise<void> => {
        const now = Date.now();
        const lookahead = options.lookaheadMs ?? LOOKAHEAD_MS;
        const found = await call<{ items?: WatchedEvent[] }>(session, {
            url: `${CALENDAR}/calendars/primary/events`,
            query: {
                timeMin: new Date(now).toISOString(),
                timeMax: new Date(now + lookahead).toISOString(),
                singleEvents: true,
                orderBy: "startTime",
                maxResults: 20,
            },
        });
        const announced = pruneAnnounced(mark.announced ?? {}, now, ANNOUNCED_KEEP_MS);
        for (const event of found.items ?? []) {
            const start = event.start?.dateTime;
            // All-day entries have no `dateTime` and never "start" at a moment worth waking for.
            if (start === undefined || announced[event.id] !== undefined) {
                continue;
            }
            announced[event.id] = start;
            await ctx.daemon.dispatch({
                provider: "google",
                type: "event",
                id: event.id,
                channelId: "primary",
                author: { id: event.organizer?.email ?? connection.email, name: event.organizer?.email ?? connection.email },
                content: [
                    event.summary ?? "(no title)",
                    `starts ${start}`,
                    ...(event.location === undefined ? [] : [`at ${event.location}`]),
                    ...(event.hangoutLink === undefined ? [] : [event.hangoutLink]),
                ].join(" — "),
                timestamp: new Date(now).toISOString(),
                extra: {
                    account: connection.name,
                    eventId: event.id,
                    calendarId: "primary",
                    start,
                    end: event.end?.dateTime,
                    location: event.location,
                    meet: event.hangoutLink,
                    link: event.htmlLink,
                    attendees: (event.attendees ?? []).map((attendee) => attendee.email).filter((email) => email !== undefined),
                },
            });
        }
        await save({ ...mark, announced });
    };

    const tick = async (what: "mail" | "calendar", poll: () => Promise<void>): Promise<void> => {
        if (!running) {
            return;
        }
        if (!loaded) {
            mark = await readWatermark(path);
            loaded = true;
        }
        await guard(what, poll);
    };

    const timers = [
        setInterval(() => void tick("mail", pollMail), options.mailIntervalMs ?? MAIL_INTERVAL_MS),
        setInterval(() => void tick("calendar", pollCalendar), options.calendarIntervalMs ?? CALENDAR_INTERVAL_MS),
    ];
    // Runs once immediately rather than waiting a minute, so a connection added mid-conversation starts watching now.
    void tick("mail", pollMail);
    void tick("calendar", pollCalendar);

    return {
        stop: () => {
            running = false;
            for (const timer of timers) {
                clearInterval(timer);
            }
        },
        alive: () => running,
    };
};
