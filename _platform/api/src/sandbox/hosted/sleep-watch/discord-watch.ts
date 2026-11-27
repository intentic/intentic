import type { Logger } from "pino";
import { addressedToBot, type DiscordThread, type GatewayEvent, gatewayFrameOf } from "./discord-frames.js";

/* ONE DISCORD BOT, HELD WHILE ITS SANDBOX SLEEPS (2026-11-27): a gateway connection that only notices, for the sleep
 * watcher (sleep-watch-worker.ts). Discord pushes a message to a bot only down a live gateway connection, so a hosted
 * sandbox that sleeps hears nothing unless something outside it holds one.
 *
 * It asks for the least that tells a message is for the bot: GUILDS (which threads the bot owns, from the server's own
 * list and thread events), GUILD_MESSAGES and DIRECT_MESSAGES, and never the privileged MESSAGE_CONTENT
 * (discord-frames.ts says which messages count). What it hands on is where the message is, never what it says.
 *
 * Plain WebSocket (Bun's global one; Node has the same since 22) and the gateway's JSON encoding, no library: the five
 * opcodes a listener needs are a page, and discord.js would bring its caches, REST client and sharding manager for a
 * connection that reads one event. It heartbeats on the gateway's interval and takes a beat left unanswered as a dead
 * connection; it resumes a dropped session where Discord allows and identifies again where it does not, backing off
 * from a second to five minutes, so a bot that keeps failing spends at most a few hundred of the thousand identifies
 * Discord allows it a day. A token Discord refuses (4004) or intents it will not grant end the watch. */

export const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES: no privileged intent.
export const DISCORD_WATCH_INTENTS = (1 << 0) | (1 << 9) | (1 << 12);
const QUERY = "?v=10&encoding=json";
// Close codes no reconnect answers: the token (4004), a shard (4010, 4011), the API version (4012) or the intents (4013,
// 4014). Everything else is reconnected, resuming the session unless Discord said it is gone (4007, 4009).
const REFUSALS: ReadonlyMap<number, string> = new Map([
    [4004, "Discord refused the bot token"],
    [4010, "Discord refused the shard"],
    [4011, "Discord requires this bot to shard"],
    [4012, "Discord refused the gateway version"],
    [4013, "Discord refused the intents"],
    [4014, "Discord refused the intents as not enabled for this bot"],
]);
const SESSION_GONE: ReadonlySet<number> = new Set([4007, 4009]);
// The code a watch closes its own socket with when it means to resume: 1000 and 1001 would end the session.
export const RECONNECT_CODE = 4000;
// Threads remembered per bot: a team server has a few dozen open at once; a flood cannot grow it past this.
const OWNED_THREADS_MAX = 2_000;

// What the watch hands on: where one message for the bot is.
export interface HeardMessage {
    readonly channelId: string;
    readonly messageId: string;
    readonly guildId?: string;
}

export interface SocketEvents {
    readonly message: (text: string) => void;
    readonly closed: (code: number) => void;
}
export interface GatewaySocket {
    readonly send: (text: string) => void;
    readonly close: (code: number) => void;
}
// Opens a socket to `url`, telling `events` what arrives on it; the one seam a test replaces with a fake gateway.
export type OpenSocket = (url: string, events: SocketEvents) => GatewaySocket;

// Runs `fn` after `ms`, answering how to cancel it; the clock a test replaces.
export type After = (ms: number, fn: () => void) => () => void;

export interface DiscordWatchHooks {
    readonly heard: (message: HeardMessage) => void;
    // Discord refused the bot for good: the watch has stopped.
    readonly refused: (why: string) => void;
    readonly log: Pick<Logger, "info" | "warn">;
}

export interface DiscordWatchOptions {
    readonly open?: OpenSocket;
    readonly after?: After;
    // In [0, 1): the share of a heartbeat interval before the first beat, and the jitter on a backoff.
    readonly random?: () => number;
    readonly backoffMs?: { readonly first: number; readonly max: number };
}

export type DiscordWatchState = "connecting" | "ready" | "stopped";

export interface DiscordWatch {
    readonly state: () => DiscordWatchState;
    readonly close: () => void;
}

const decoder = new TextDecoder();

// The platform's WebSocket, as the watch reads it. An error is always followed by a close, which is what it acts on.
const webSocket: OpenSocket = (url, events) => {
    const socket = new WebSocket(url);
    socket.addEventListener("message", (event: MessageEvent) =>
        events.message(event.data instanceof ArrayBuffer ? decoder.decode(event.data) : String(event.data)),
    );
    socket.addEventListener("close", (event: CloseEvent) => events.closed(event.code));
    return { send: (text) => socket.send(text), close: (code) => socket.close(code) };
};

const timers: After = (ms, fn) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
};

// What the watch sends: a heartbeat's last sequence number, an identify, or a resume.
type Outgoing =
    | number
    | null
    | { readonly token: string; readonly intents: number; readonly properties: Readonly<Record<"os" | "browser" | "device", string>> }
    | { readonly token: string; readonly session_id: string; readonly seq: number | null };

class Watch {
    status: DiscordWatchState = "connecting";
    private socket: GatewaySocket | undefined;
    private session: { readonly id: string; readonly resumeUrl: string } | undefined;
    private seq: number | null = null;
    private botId: string | undefined;
    private failures = 0;
    private acked = true;
    private cancelBeat: (() => void) | undefined;
    private cancelRetry: (() => void) | undefined;
    private readonly owned = new Set<string>();
    private readonly open: OpenSocket;
    private readonly after: After;
    private readonly random: () => number;
    private readonly backoff: { readonly first: number; readonly max: number };

    constructor(
        private readonly token: string,
        private readonly hooks: DiscordWatchHooks,
        options: DiscordWatchOptions,
    ) {
        this.open = options.open ?? webSocket;
        this.after = options.after ?? timers;
        this.random = options.random ?? Math.random;
        this.backoff = options.backoffMs ?? { first: 1_000, max: 5 * 60_000 };
    }

    connect(): void {
        this.cancelRetry = undefined;
        if (this.status === "stopped") {
            return;
        }
        this.status = "connecting";
        this.acked = true;
        const url = this.session === undefined ? DISCORD_GATEWAY_URL : `${this.session.resumeUrl.replace(/\/+$/u, "")}/${QUERY}`;
        const mine: GatewaySocket = this.open(url, {
            message: (text) => {
                const frame = this.socket === mine ? gatewayFrameOf(text) : undefined;
                if (frame?.seq !== undefined) {
                    this.seq = frame.seq;
                }
                if (frame !== undefined) {
                    this.act(frame.event);
                }
            },
            closed: (code) => {
                if (this.socket === mine) {
                    this.closed(code);
                }
            },
        });
        this.socket = mine;
    }

    stop(): void {
        this.status = "stopped";
        this.cancelRetry?.();
        this.cancelRetry = undefined;
        this.drop();
    }

    private send(op: number, d: Outgoing): void {
        this.socket?.send(JSON.stringify({ op, d }));
    }

    private stopBeating(): void {
        this.cancelBeat?.();
        this.cancelBeat = undefined;
    }

    // Close our side of the socket, ignoring anything it says after.
    private drop(): void {
        this.stopBeating();
        const was = this.socket;
        this.socket = undefined;
        was?.close(RECONNECT_CODE);
    }

    private retry(delayMs: number): void {
        this.cancelRetry?.();
        this.cancelRetry = this.after(delayMs, () => this.connect());
    }

    private backoffMs(): number {
        const ceiling = Math.min(this.backoff.max, this.backoff.first * 2 ** this.failures);
        this.failures += 1;
        return Math.round(ceiling * (0.5 + this.random() / 2));
    }

    // A dead connection or Discord's word to reconnect: close our side and come back, resuming when the session stands.
    private reconnect(delayMs: number): void {
        this.drop();
        this.retry(delayMs);
    }

    // The socket Discord or the network closed: refused for good, or reconnected after a backoff.
    private closed(code: number): void {
        this.stopBeating();
        this.socket = undefined;
        const refusal = REFUSALS.get(code);
        if (refusal !== undefined) {
            this.stop();
            this.hooks.refused(`${refusal} (${code})`);
            return;
        }
        if (SESSION_GONE.has(code)) {
            this.session = undefined;
        }
        this.retry(this.backoffMs());
    }

    private heartbeat(intervalMs: number, firstMs: number): void {
        this.stopBeating();
        this.cancelBeat = this.after(firstMs, () => {
            if (!this.acked) {
                this.hooks.log.warn("discord watch: a heartbeat went unanswered; reconnecting");
                this.reconnect(this.backoffMs());
                return;
            }
            this.acked = false;
            this.send(1, this.seq);
            this.heartbeat(intervalMs, intervalMs);
        });
    }

    private hello(intervalMs: number): void {
        this.heartbeat(intervalMs, Math.round(intervalMs * this.random()));
        if (this.session !== undefined) {
            this.send(6, { token: this.token, session_id: this.session.id, seq: this.seq });
            return;
        }
        this.send(2, { token: this.token, intents: DISCORD_WATCH_INTENTS, properties: { os: "linux", browser: "intentic", device: "intentic" } });
    }

    private own(threads: readonly DiscordThread[]): void {
        for (const thread of threads) {
            if (this.botId !== undefined && thread.owner_id === this.botId && this.owned.size < OWNED_THREADS_MAX) {
                this.owned.add(thread.id);
            }
        }
    }

    private act(event: GatewayEvent): void {
        switch (event.kind) {
            case "hello":
                return this.hello(event.intervalMs);
            case "ack":
                this.acked = true;
                return;
            case "beat":
                return this.send(1, this.seq);
            case "reconnect":
                return this.reconnect(0);
            case "invalid":
                if (!event.resumable) {
                    this.session = undefined;
                    this.seq = null;
                }
                return this.reconnect(1_000 + Math.round(this.random() * 4_000));
            case "ready":
                this.botId = event.botId;
                this.session = { id: event.sessionId, resumeUrl: event.resumeUrl };
                return this.ready();
            case "resumed":
                return this.ready();
            case "threads":
                return this.own(event.threads);
            case "thread-gone":
                this.owned.delete(event.id);
                return;
            case "message":
                return this.message(event.message);
            case "other":
                return;
        }
    }

    private ready(): void {
        this.status = "ready";
        this.failures = 0;
    }

    private message(message: Extract<GatewayEvent, { kind: "message" }>["message"]): void {
        if (this.botId === undefined || !addressedToBot(message, this.botId, this.owned)) {
            return;
        }
        const { id: messageId, channel_id: channelId, guild_id: guildId } = message;
        this.hooks.heard(guildId === undefined ? { channelId, messageId } : { channelId, messageId, guildId });
    }
}

/** Holds one bot's gateway connection until closed or refused, telling `hooks` of every message for the bot. */
export const watchDiscord = (token: string, hooks: DiscordWatchHooks, options: DiscordWatchOptions = {}): DiscordWatch => {
    const watch = new Watch(token, hooks, options);
    watch.connect();
    return { state: () => watch.status, close: () => watch.stop() };
};
