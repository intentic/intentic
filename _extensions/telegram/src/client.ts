/* The gateway's Telegram connections, one long-polling loop plus one Bot API caller per configured bot, alive
 * only while the daemon says an enabled telegram listener automation exists. A module singleton map, like
 * ext-slack's and ext-discord's: the reconcile loop and the listener both reach it directly.
 *
 * There is no SDK here on purpose. The Bot API is HTTPS + JSON with one envelope shape, and the whole
 * connection is `getUpdates` in a loop, an OUTBOUND call, so Telegram needs no public URL to reach the agent
 * and there is no request signature to verify. A dependency would buy us a thin wrapper over `fetch` and cost a
 * deploy tree; what this file adds instead is the pool, the identity probe, the poll loop's error taxonomy, and
 * turning a rejection into a sentence the owner can act on. */

const API_BASE = "https://api.telegram.org";
// The long-poll hold. Telegram caps it at ~50s; a held request that finds nothing simply returns empty, so this
// is idle cost, not latency.
const POLL_TIMEOUT_S = 50;
// Backoff after a transient poll failure (network blip, 5xx, a 429 with no retry_after), doubling to the cap.
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
// Only the update kinds this gateway turns into agent turns, asking for fewer keeps edits, reactions, join
// notices and inline queries out of the loop entirely rather than filtering them after the fact.
const ALLOWED_UPDATES = ["message", "channel_post"];

// The bits of a Telegram user this gateway reads. `is_bot` is what keeps a room of bots from waking each other.
export interface TelegramUser {
    readonly id: number;
    readonly is_bot?: boolean;
    readonly username?: string;
    readonly first_name?: string;
    readonly last_name?: string;
}

export interface TelegramChat {
    readonly id: number;
    // "private" | "group" | "supergroup" | "channel", an open string, since Telegram adds kinds.
    readonly type: string;
    readonly title?: string;
    readonly username?: string;
}

export interface TelegramMessage {
    readonly message_id: number;
    readonly from?: TelegramUser;
    readonly chat: TelegramChat;
    readonly date: number;
    readonly text?: string;
    readonly caption?: string;
    // Forum topics: a supergroup's threads. The reply has to carry it back or the answer lands in "General".
    readonly message_thread_id?: number;
    readonly reply_to_message?: TelegramMessage;
    readonly entities?: ReadonlyArray<{ type: string; offset: number; length: number }>;
    readonly caption_entities?: ReadonlyArray<{ type: string; offset: number; length: number }>;
    readonly photo?: ReadonlyArray<{ file_id: string; file_size?: number }>;
    readonly document?: { file_id: string; file_name?: string; mime_type?: string };
    readonly voice?: { file_id: string; duration?: number; mime_type?: string };
    readonly audio?: { file_id: string; file_name?: string; duration?: number };
    readonly video?: { file_id: string; file_name?: string; duration?: number };
}

export interface TelegramUpdate {
    readonly update_id: number;
    readonly message?: TelegramMessage;
    readonly channel_post?: TelegramMessage;
}

export interface TelegramConnection {
    readonly botToken: string;
    // The Bot API caller: `call("sendMessage", { chat_id, text })`. Rejects with TelegramApiError on `ok: false`.
    readonly call: <T>(method: string, body?: object) => Promise<T>;
    // The bot's own numeric id and @username. Needed on every inbound message: they are how the listener
    // recognizes a mention (`@thebot`, or a reply to one of its own posts) and how it drops its own messages
    // instead of waking on them.
    readonly selfId: number;
    readonly username: string;
    // Start the long-poll loop. `onFatal` fires once, for the failures a retry can never fix, the connection
    // has already removed itself from the pool by then, so the caller's job is to report, not to clean up.
    readonly listen: (onUpdate: (update: TelegramUpdate) => void, onFatal: (error: Error) => void) => void;
}

const connections = new Map<string, TelegramConnection>();
// Per-token teardown, kept beside the pool rather than on the connection: closing is the reconcile loop's move,
// and it addresses a bot by the token it reconciled, not by an object it may no longer hold.
const closers = new Map<string, () => void>();

export const telegramConnection = (botToken: string): TelegramConnection | undefined => connections.get(botToken);
export const telegramConnections = (): ReadonlyMap<string, TelegramConnection> => connections;

export const closeTelegramConnection = (botToken: string): void => {
    connections.delete(botToken);
    closers.get(botToken)?.();
    closers.delete(botToken);
};

// Fatal: retrying with the same token and BotFather state can never succeed, so the caller pauses this token
// instead of hammering Telegram. The message names what the owner has to fix.
export class FatalTelegramError extends Error {}

// Telegram answers `{ ok: false, error_code, description }` with a matching HTTP status. The description is the
// only human-readable part, so it rides the error rather than being flattened into a status number.
export class TelegramApiError extends Error {
    constructor(
        readonly code: number,
        readonly description: string,
        readonly retryAfterMs?: number,
    ) {
        super(`telegram ${code}: ${description}`);
    }
}

interface ApiEnvelope<T> {
    readonly ok: boolean;
    readonly result?: T;
    readonly error_code?: number;
    readonly description?: string;
    readonly parameters?: { retry_after?: number };
}

const callWith = async <T>(botToken: string, method: string, body: object | undefined, signal: AbortSignal | undefined): Promise<T> => {
    const res = await fetch(`${API_BASE}/bot${botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        ...(signal === undefined ? {} : { signal }),
    });
    const envelope = (await res.json()) as ApiEnvelope<T>;
    if (!envelope.ok) {
        const retryAfter = envelope.parameters?.retry_after;
        throw new TelegramApiError(
            envelope.error_code ?? res.status,
            envelope.description ?? "no description",
            retryAfter === undefined ? undefined : retryAfter * 1_000,
        );
    }
    return envelope.result as T;
};

/* Which API rejections are worth pausing the token for. 401/403/404 are a dead or wrong token. 409 is the one
 * that is a CONFIGURATION clash rather than a credential: Telegram allows exactly one reader per bot, so either
 * a webhook is registered (someone wired this bot to a server) or a second poller is running. We refuse to
 * `deleteWebhook` our way out of that, it would silently break whatever else the owner pointed this bot at. */
const fatalMessage = (error: TelegramApiError): string | undefined => {
    if (error.code === 401 || error.code === 404) {
        return `Telegram rejected the bot token (${error.description}): paste a fresh token from @BotFather on the Telegram capability`;
    }
    if (error.code === 403) {
        return `Telegram refused this bot (${error.description}): it may have been deleted or blocked; check it with @BotFather`;
    }
    if (error.code === 409) {
        return `Another reader is already receiving this bot's updates (${error.description}): remove its webhook, or give this sandbox a bot of its own`;
    }
    return undefined;
};

export const openTelegramConnection = async (botToken: string): Promise<TelegramConnection> => {
    // The two calls that make a connection. Both reject on failure, a transient one leaves the gateway to
    // retry on its next reconcile, and a fatal one names what the owner has to fix.
    const connectCall = async <T>(method: string, body?: object): Promise<T> =>
        callWith<T>(botToken, method, body, undefined).catch((error: unknown) => {
            const message = error instanceof TelegramApiError ? fatalMessage(error) : undefined;
            throw message === undefined ? error : new FatalTelegramError(message);
        });

    const identity = await connectCall<TelegramUser>("getMe");
    if (identity.username === undefined) {
        throw new FatalTelegramError("Telegram accepted the token but the bot has no username: give it one with @BotFather");
    }

    /* Start from NOW, not from the backlog. Telegram queues undelivered updates for 24 hours, so a gateway that
     * simply polled from zero after a restart would wake an agent for every message sent while the sandbox was
     * asleep, a day of chatter answered at once, hours late. Reading the queue's tail (`offset: -1`) tells us
     * where the end is; the next poll confirms everything up to it, which discards the rest. Discord and Slack
     * behave this way because their sockets have no backlog at all; here it has to be chosen, which is why a
     * failure here fails the whole connect rather than falling through to a poll that would replay the day. */
    const tail = await connectCall<TelegramUpdate[]>("getUpdates", { offset: -1, timeout: 0 });
    const last = tail.at(-1);
    let offset = last === undefined ? undefined : last.update_id + 1;

    // Aborts the in-flight long poll on close. Without it a 50s held request outlives the connection it belongs
    // to, and the reconnect that follows a token edit collides with it, which Telegram answers as a 409.
    const aborter = new AbortController();
    let closed = false;

    const connection: TelegramConnection = {
        botToken,
        selfId: identity.id,
        username: identity.username,
        call: (method, body) => callWith(botToken, method, body, undefined),
        listen: (onUpdate, onFatal) => {
            let backoff = RETRY_MIN_MS;
            const loop = async (): Promise<void> => {
                for (;;) {
                    // `closed` flips from the closer registered below, which is another task's turn to run,
                    // hence the re-read each pass rather than a loop condition.
                    if (closed) {
                        return;
                    }
                    try {
                        const updates = await callWith<TelegramUpdate[]>(
                            botToken,
                            "getUpdates",
                            { ...(offset === undefined ? {} : { offset }), timeout: POLL_TIMEOUT_S, allowed_updates: ALLOWED_UPDATES },
                            aborter.signal,
                        );
                        backoff = RETRY_MIN_MS;
                        for (const update of updates) {
                            // Advance BEFORE handling: the offset is an acknowledgement, and an update that
                            // makes the listener throw must not be redelivered forever.
                            offset = update.update_id + 1;
                            onUpdate(update);
                        }
                    } catch (error) {
                        if (closed) {
                            return;
                        }
                        const fatal = error instanceof TelegramApiError ? fatalMessage(error) : undefined;
                        if (fatal !== undefined) {
                            // Leave the pool before reporting: the reconcile loop reads the pool to decide what
                            // is really connected, and a dead entry there reads as healthy.
                            closeTelegramConnection(botToken);
                            onFatal(new FatalTelegramError(fatal));
                            return;
                        }
                        const wait = error instanceof TelegramApiError ? (error.retryAfterMs ?? backoff) : backoff;
                        await new Promise((resolve) => setTimeout(resolve, wait));
                        backoff = Math.min(backoff * 2, RETRY_MAX_MS);
                    }
                }
            };
            void loop();
        },
    };
    connections.set(botToken, connection);
    closers.set(botToken, () => {
        closed = true;
        aborter.abort();
    });
    return connection;
};
