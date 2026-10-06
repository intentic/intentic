import { createBackoff } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { effectScope, onScopeDispose, type Ref, watch } from "vue";
import { useSandbox } from "../sandbox/useSandbox";

// One long-lived socket to the daemon that keeps itself alive: mint an address (a one-shot ticket, wsTicket.ts), dial,
// ping, close a socket that has gone silent, and dial again on a ladder that drops back to its floor after a healthy
// connection, or at once when the sandbox answers again. The browser view, the desktop view, a terminal and a
// connected account's browser window each ride one; what they say on it, and what they show while it is down, stays
// theirs.

export interface LiveTiming {
    // How often a ping goes out; the daemons pong every one.
    readonly pingMs: number;
    // The ladder's first rung and its ceiling.
    readonly retryMs: number;
    readonly maxRetryMs: number;
    // A connection alive this long was healthy: its drop starts the ladder over.
    readonly stableMs: number;
    // Silence this long, pings unanswered, means a half-open socket; it is closed, which dials again.
    readonly staleMs: number;
}

// The same for every live socket in the editor: no caller has had a reason to differ.
export const LIVE_TIMING: LiveTiming = { pingMs: 30_000, retryMs: 1000, maxRetryMs: 30_000, stableMs: 5000, staleMs: 90_000 };

const PING = { type: `ping` } as const;

// What the opened channel reports back. `current` is false for a channel this socket has since replaced or let go
// of, whose messages are nobody's.
export interface LiveLink {
    readonly opened: () => void;
    readonly heard: () => void;
    readonly closed: (code: number, reason: string) => void;
    readonly current: () => boolean;
}

// One dialled connection: JSON out once open, and a close whose answer arrives through `LiveLink.closed`.
export interface LiveChannel<Out> {
    readonly send: (message: Out | typeof PING) => void;
    readonly close: () => void;
    // Whether a send would go out now; a channel that cannot say is never reported open.
    readonly ready?: () => boolean;
}

export interface LiveSocketOptions<Address, Out> {
    // Where to dial, undefined while the sandbox is unreachable or nobody is signed in; a throw retries like a drop.
    readonly mint: () => Promise<Address | undefined>;
    readonly open: (address: Address, link: LiveLink) => LiveChannel<Out>;
    // A permit held for the life of one channel (the terminal's stream budget), handed back once it closes.
    readonly lease?: () => Promise<(() => void) | undefined>;
    readonly onOpen?: () => void;
    // Always an Error: a thrown non-Error arrives wrapped, its text as the message.
    readonly onMintFailed?: (error: Error) => void;
    readonly onUnreachable?: () => void;
    // The current channel closed by itself. Calling `end()` here is how a close that means "never again" says so.
    readonly onDrop?: (code: number, reason: string) => void;
    // `once-ponged` holds a socket to the silence clock only after it heard a pong (`ponged()`): for a route a daemon
    // from before its ping existed answers with nothing, whose still picture would otherwise read as half-open.
    readonly staleCheck?: `always` | `once-ponged`;
    readonly reachable?: Ref<boolean>;
    readonly timing?: Partial<LiveTiming>;
}

export interface LiveSocket<Out> {
    // Lets any connection go and dials afresh, the ladder at its floor.
    readonly connect: () => void;
    // No more dialling; the current channel stays until it closes, and that close is nobody's.
    readonly end: () => void;
    // Ends, and closes the channel and any pending retry now.
    readonly close: () => void;
    // Closes, and stops following the sandbox's reachability; nothing is dialled again.
    readonly dispose: () => void;
    readonly send: (message: Out) => void;
    readonly isOpen: () => boolean;
    // True while a retry is waiting out its rung.
    readonly retrying: () => boolean;
    // The peer answered a ping (see `staleCheck`).
    readonly ponged: () => void;
}

const { reachable: sandboxReachable } = useSandbox();

// The plain form, for a caller outside any component scope (a terminal outlives the pane that opened it); it must be
// disposed by hand. `useLiveSocket` ties it to the calling scope.
export const liveSocket = <Address, Out extends object = object>(options: LiveSocketOptions<Address, Out>): LiveSocket<Out> => {
    const timing = { ...LIVE_TIMING, ...options.timing };
    const ladder = createBackoff({ floorMs: timing.retryMs, capMs: timing.maxRetryMs, stableMs: timing.stableMs });
    let channel: LiveChannel<Out> | undefined;
    let retry: number | undefined;
    let ended = true;
    // Bumped on every fresh dial and every close, so a mint or lease still in flight for the one before stands down.
    let generation = 0;
    let ponged = false;

    const stale = (dialled: number): boolean => ended || dialled !== generation;

    const schedule = (dialled: number, uptimeMs = 0): void => {
        retry = window.setTimeout(() => void dial(dialled), ladder.next(uptimeMs));
    };

    const watchChannel = (dialled: number, release: (() => void) | undefined): LiveLink & { mine?: LiveChannel<Out> } => {
        let ping: number | undefined;
        let openedAt = 0;
        let heardAt = 0;
        let released = false;
        const link: LiveLink & { mine?: LiveChannel<Out> } = {
            current: () => link.mine !== undefined && channel === link.mine,
            opened: () => {
                if (ended || channel !== link.mine) {
                    link.mine?.close();
                    return;
                }
                openedAt = Date.now();
                heardAt = openedAt;
                ponged = false;
                options.onOpen?.();
                ping = window.setInterval(() => {
                    // Replaced: nobody's now, so neither pinged nor judged by the silence clock; its own close ends it.
                    if (channel !== link.mine) {
                        window.clearInterval(ping);
                        return;
                    }
                    const judged = options.staleCheck !== `once-ponged` || ponged;
                    if (judged && Date.now() - heardAt > timing.staleMs) {
                        // Given up once: a half-open socket's close can take its closing handshake's whole timeout to
                        // come back, and until it does nothing more is sent on it nor is it closed again.
                        window.clearInterval(ping);
                        link.mine?.close();
                        return;
                    }
                    link.mine?.send(PING);
                }, timing.pingMs);
            },
            heard: () => {
                heardAt = Date.now();
            },
            closed: (code, reason) => {
                window.clearInterval(ping);
                // Before the currency check, so a replaced straggler hands its permit back too, exactly once.
                if (!released) {
                    released = true;
                    release?.();
                }
                if (stale(dialled) || channel !== link.mine) {
                    return;
                }
                options.onDrop?.(code, reason);
                if (!stale(dialled)) {
                    schedule(dialled, openedAt === 0 ? 0 : Date.now() - openedAt);
                }
            },
        };
        return link;
    };

    const dial = async (dialled: number): Promise<void> => {
        window.clearTimeout(retry);
        retry = undefined;
        if (stale(dialled)) {
            return;
        }
        let address: Address | undefined;
        try {
            address = await options.mint();
        } catch (error) {
            if (stale(dialled)) {
                return;
            }
            options.onMintFailed?.(error instanceof Error ? error : new Error(errorMessage(error)));
            if (!stale(dialled)) {
                schedule(dialled);
            }
            return;
        }
        if (stale(dialled)) {
            return;
        }
        if (address === undefined) {
            options.onUnreachable?.();
            if (!stale(dialled)) {
                schedule(dialled);
            }
            return;
        }
        const release = options.lease === undefined ? undefined : await options.lease();
        if (stale(dialled)) {
            release?.();
            return;
        }
        const link = watchChannel(dialled, release);
        const mine = options.open(address, link);
        link.mine = mine;
        // Replaces any straggler; its handlers see they are no longer current and stay silent.
        channel?.close();
        channel = mine;
    };

    const letGo = (): void => {
        window.clearTimeout(retry);
        retry = undefined;
        generation += 1;
        const old = channel;
        channel = undefined;
        old?.close();
    };

    const close = (): void => {
        ended = true;
        letGo();
    };

    // The sandbox's event stream answering again is the news a socket waiting out a rung is waiting for: without it, one
    // whose ladder had climbed to its ceiling stayed dark that long after the rest of the page was back.
    const scope = effectScope(true);
    scope.run(() =>
        watch(options.reachable ?? sandboxReachable, (up) => {
            if (up && retry !== undefined) {
                ladder.reset();
                void dial(generation);
            }
        }),
    );

    return {
        connect: () => {
            letGo();
            ended = false;
            ladder.reset();
            void dial(generation);
        },
        end: () => {
            ended = true;
            window.clearTimeout(retry);
            retry = undefined;
        },
        close,
        dispose: () => {
            close();
            scope.stop();
        },
        send: (message) => channel?.send(message),
        isOpen: () => channel?.ready?.() === true,
        retrying: () => retry !== undefined,
        ponged: () => {
            ponged = true;
        },
    };
};

// The same, disposed with the calling component or effect scope.
export const useLiveSocket = <Address, Out extends object = object>(options: LiveSocketOptions<Address, Out>): LiveSocket<Out> => {
    const live = liveSocket(options);
    onScopeDispose(live.dispose);
    return live;
};

// What arrives on a picture socket: text frames (JSON the caller reads) and binary ones (a picture), apart.
export interface SocketFrames {
    readonly text: (text: string) => void;
    readonly binary: (data: ArrayBuffer) => void;
}

// A browser WebSocket to `url` as a live channel; only the current channel's frames reach `frames`.
export const webSocketChannel =
    <Out extends object>(frames: SocketFrames) =>
    (url: string, link: LiveLink): LiveChannel<Out> => {
        const ws = new WebSocket(url);
        ws.binaryType = `arraybuffer`;
        ws.addEventListener(`open`, () => link.opened());
        ws.addEventListener(`message`, (event: MessageEvent<unknown>) => {
            link.heard();
            if (!link.current()) {
                return;
            }
            if (event.data instanceof ArrayBuffer) {
                frames.binary(event.data);
            } else {
                frames.text(String(event.data));
            }
        });
        ws.addEventListener(`close`, (event: CloseEvent) => link.closed(event.code, event.reason));
        const ready = (): boolean => ws.readyState === WebSocket.OPEN;
        return {
            send: (message) => {
                if (ready()) {
                    ws.send(JSON.stringify(message));
                }
            },
            close: () => ws.close(),
            ready,
        };
    };
