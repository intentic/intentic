import { createBackoff, sleep } from "@intentic/base/async";
// One long-poll loop + Bot API caller per configured bot, alive while the daemon reports an enabled listener
// automation; a module singleton for the reconcile loop and the listener. No SDK: the Bot API is HTTPS+JSON, an
// outbound `getUpdates` loop needing no public URL; this file adds the pool, identity probe, and error taxonomy.

const API_BASE = "https://api.telegram.org";
// Long-poll hold, capped by Telegram at ~50s; an empty result after that is idle cost, not latency.
const POLL_TIMEOUT_S = 50;
// Backoff after a transient poll failure (network blip, 5xx, a 429 with no retry_after), doubling to the cap.
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
// Only kinds this gateway turns into turns; fewer keeps the rest out of the loop, not filtered after.
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
    // Bot's own id and @username: how the listener recognizes a mention or self-reply and ignores its own messages.
    readonly selfId: number;
    readonly username: string;
    // Starts the poll loop; `onFatal` fires once, after the connection has already left the pool.
    readonly listen: (onUpdate: (update: TelegramUpdate) => void, onFatal: (error: Error) => void) => void;
}

const connections = new Map<string, TelegramConnection>();
// Per-token teardown beside the pool, since closing addresses a bot by its token, not a connection object.
const closers = new Map<string, () => void>();

export const telegramConnection = (botToken: string): TelegramConnection | undefined => connections.get(botToken);
export const telegramConnections = (): ReadonlyMap<string, TelegramConnection> => connections;

export const closeTelegramConnection = (botToken: string): void => {
    connections.delete(botToken);
    closers.get(botToken)?.();
    closers.delete(botToken);
};

// Fatal: retrying the same token can never succeed; the caller should pause it. Message names what to fix.
export class FatalTelegramError extends Error {}

// Telegram's `{ ok: false, error_code, description }`; description is the only human-readable part, so it rides on the
// error.
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

// 401/403/404 mean a dead or wrong token; 409 is a configuration clash, Telegram allows only one reader per bot. Never
// auto-clears a webhook: it could break whatever else the owner pointed the bot at.
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
    // The two calls that make a connection: a transient failure retries next reconcile, a fatal one names the fix.
    const connectCall = async <T>(method: string, body?: object): Promise<T> =>
        callWith<T>(botToken, method, body, undefined).catch((error: unknown) => {
            const message = error instanceof TelegramApiError ? fatalMessage(error) : undefined;
            throw message === undefined ? error : new FatalTelegramError(message);
        });

    const identity = await connectCall<TelegramUser>("getMe");
    if (identity.username === undefined) {
        throw new FatalTelegramError("Telegram accepted the token but the bot has no username: give it one with @BotFather");
    }

    // Starts from now, not the backlog: Telegram queues updates 24h, and replaying them after a restart would wake the
    // agent on stale chatter. The tail read (`offset: -1`) marks where to resume; a failure here fails the whole
    // connect.
    const tail = await connectCall<TelegramUpdate[]>("getUpdates", { offset: -1, timeout: 0 });
    const last = tail.at(-1);
    let offset = last === undefined ? undefined : last.update_id + 1;

    // Aborts the in-flight poll on close, so it can't outlive its connection and collide with the next (409).
    const aborter = new AbortController();
    let closed = false;

    const connection: TelegramConnection = {
        botToken,
        selfId: identity.id,
        username: identity.username,
        call: (method, body) => callWith(botToken, method, body, undefined),
        listen: (onUpdate, onFatal) => {
            const ladder = createBackoff({ floorMs: RETRY_MIN_MS, capMs: RETRY_MAX_MS });
            const loop = async (): Promise<void> => {
                for (;;) {
                    // `closed` flips from the closer below on another task's turn, hence a re-read each pass, not a
                    // loop condition.
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
                        ladder.reset();
                        for (const update of updates) {
                            // Advances before handling: the offset acknowledges it, so a throwing listener isn't
                            // redelivered forever.
                            offset = update.update_id + 1;
                            onUpdate(update);
                        }
                    } catch (error) {
                        if (closed) {
                            return;
                        }
                        const fatal = error instanceof TelegramApiError ? fatalMessage(error) : undefined;
                        if (fatal !== undefined) {
                            // Leaves the pool before reporting, or the reconcile loop would still read this dead entry
                            // as healthy.
                            closeTelegramConnection(botToken);
                            onFatal(new FatalTelegramError(fatal));
                            return;
                        }
                        const rung = ladder.next();
                        await sleep(error instanceof TelegramApiError ? (error.retryAfterMs ?? rung) : rung);
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
