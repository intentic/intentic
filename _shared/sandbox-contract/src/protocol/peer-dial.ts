// The one outbound socket a peer (machine agent, webext, runner) holds to its sandbox: hello carries the enrollment
// token in the frame, then the link is pure oRPC. Reconnects on backoff after any drop except a revoked enrollment
// (code 1008), which never retries.
//
// THE RULE BOTH ENDS ARE HELD TO: 1008 means the sandbox READ its enrollment store and does not hold this token. It
// costs the far end its pairing — someone has to walk to that machine and paste a command — so it is the one refusal
// that may never stand in for a moment the sandbox was having. A manifest mid-write, a capability card not yet
// restored after a recreate, a hello that arrived late: all of those are PEER_TRY_AGAIN, and all of them used to be
// 1008.

// Reconnect backoff: fast floor for a restart, low cap so a reopened laptop is back within a minute.
export const PEER_LINK_BACKOFF = { floorMs: 1_000, capMs: 30_000, stableMs: 60_000 } as const;

/* HOW MUCH A LINK THAT CANNOT BE REACHED IS ALLOWED TO SAY, which is a different question from how often it may try. */
const LOUD_ATTEMPTS = 3;
const QUIET_LOG_MS = 10 * 60_000;

/* HOW OFTEN A LINK NOBODY IS ANSWERING MAY TRY, once "the sandbox is restarting" has stopped being a plausible
   reading of the silence. The ladder above caps at 30s and stays there forever, which is right for the first minutes
   and absurd after the first week: a machine holding a link to a sandbox that no longer exists spent 2,880 attempts a
   day on it, and most of a 7 MB log saying so. The link is never given up — a laptop closed for a fortnight must find
   its sandboxes again — it just stops asking every half minute. Reaching the far end once resets it (`failures = 0`),
   so an outage that ends is back on the fast ladder immediately. */
export const LONG_OUTAGE_ATTEMPTS = 20;
export const LONG_OUTAGE_MS = 15 * 60_000;

/* HOW LONG A SOCKET MAY SAY NOTHING before this side calls the link dead, as a multiple of the door's own heartbeat. */
export const PEER_LINK_SILENCE_HEARTBEATS = 3;
export const peerLinkSilenceMs = (heartbeatMs: number): number => heartbeatMs * PEER_LINK_SILENCE_HEARTBEATS;

// The sandbox closes with this when the token is not enrolled: a decision, not a fault, and one that never heals.
export const PEER_UNAUTHORIZED = 1008;
// Refused, but not about this peer's credential: the sandbox could not decide right now. Retried on the ordinary
// ladder, which is the whole difference between the two.
export const PEER_TRY_AGAIN = 1013;

// WebSocket spec's readyState value for open, named so a fake socket need not import the real class.
const OPEN = 1;

// Structural interface a browser's WebSocket, node's global one, and a test's fake all satisfy without a cast.
export interface SocketLike {
    readonly readyState: number;
/* `message` is here for the watchdog alone, which needs no more than the fact that one arrived. */
    addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { readonly code?: number }) => void): void;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

export interface PeerDialSpec<S extends SocketLike> {
    // Resolves the address for this attempt, not once at startup; undefined ends the loop (pairing forgotten). `said`
    // logs once open; a resolution outliving `signal`'s abort opens nothing.
    readonly open: (signal: AbortSignal) => Promise<{ readonly socket: S; readonly said?: string } | undefined>;
    // First frame sent on open: the enrollment token plus whatever the door's hello schema asks for.
    readonly hello: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    // Hand the open socket to the oRPC handler serving the door's contract.
    readonly attach: (socket: S) => void;
    // The retry ladder: how long to wait after a drop, given how long the socket had held.
    readonly backoff: { readonly next: (heldMs: number) => number };
/* How long this socket may hear nothing before the link is presumed dead: `peerLinkSilenceMs` of the heartbeat the door's own hub pings on. */
    readonly silenceMs: number;
    readonly log: (message: string) => void;
    // Sandbox refused the enrollment (1008); the loop has already stopped, this is where the peer says so.
    readonly revoked: () => void;
}

// What the socket is doing right now. "connecting" covers a dial in flight and a retry waiting on the ladder:
// nobody should start another. Named, because processes that are not this one report it (a machine agent stamps
// it for `status`, which otherwise has only the link list on disk and no idea whether any of it is up).
export type PeerLinkState = "open" | "connecting" | "closed";

// How long this link has been failing and how many attempts it has spent, for the readers that are not this process.
// Absent while the socket is open, so "is anything wrong here" is answerable without publishing a healthy link's
// history. `since` is the first failure of THIS outage: one answer resets it.
export interface PeerOutage {
    readonly failures: number;
    readonly since: number;
}

export interface PeerLink {
    // Resolves when the loop is asked to stop or refused for good; never rejects, a connection error is a retry.
    readonly done: Promise<void>;
    readonly stop: (reason?: string) => void;
    readonly state: () => PeerLinkState;
    readonly outage: () => PeerOutage | undefined;
}

export const dialPeer = <S extends SocketLike>(spec: PeerDialSpec<S>): PeerLink => {
    const stopping = new AbortController();
    let socket: S | undefined;
    let waiting = false;
    let openedAt: number | undefined;
    // The live attempt's watchdog, reachable from `stop`: a stopped link that left a timer armed is a process
    // the runtime keeps alive for a socket nobody holds any more.
    let disarmWatchdog: () => void = () => undefined;
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    // Consecutive attempts that have failed since this link was last open, and when the loop last complained out
    // loud: between them they are the whole of the quiet rule above.
    let failures = 0;
    let quietSince = 0;
    // When the CURRENT outage began, as opposed to when this link was last complained about.
    let failingSince: number | undefined;

/* What ONE failed attempt is allowed to say. */
    const complain = (said: string, delay: number): void => {
        const every = `retrying every ${Math.round(delay / 1000)}s`;
        if (failures <= LOUD_ATTEMPTS) {
            spec.log(`${said}; reconnecting in ${Math.round(delay / 1000)}s`);
            return;
        }
        if (failures === LOUD_ATTEMPTS + 1) {
            quietSince = Date.now();
            spec.log(
                `${said}; still nothing after ${failures} attempts — ${every}, and saying so at most every ${Math.round(QUIET_LOG_MS / 60_000)} minutes from here`,
            );
            return;
        }
        if (Date.now() - quietSince >= QUIET_LOG_MS) {
            quietSince = Date.now();
            spec.log(`${said}; ${failures} failed attempts, ${every}`);
        }
    };

    const open = async (): Promise<void> => {
        waiting = true;
        const attempt = await spec.open(stopping.signal);
        waiting = false;
        // Aborted while resolving: nothing to open, `done` settled; a socket handed over late is closed, not dialled.
        if (stopping.signal.aborted) {
            attempt?.socket.close(1000, "stopping");
            return;
        }
        if (attempt === undefined) {
            stopping.abort();
            resolveDone();
            return;
        }
        const ws = attempt.socket;
        socket = ws;

        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const disarm = (): void => {
            if (watchdog !== undefined) {
                clearTimeout(watchdog);
                watchdog = undefined;
            }
        };
        disarmWatchdog = disarm;

        /* An attempt drop is recorded when either endpoint notices the closed far end. */
        let dropped = false;
        const drop = (said: string): void => {
            if (dropped) {
                return;
            }
            dropped = true;
            disarm();
            if (socket === ws) {
                socket = undefined;
            }
            if (stopping.signal.aborted) {
                resolveDone();
                return;
            }
            const rung = spec.backoff.next(openedAt === undefined ? 0 : Date.now() - openedAt);
            openedAt = undefined;
            failures += 1;
            failingSince ??= Date.now();
            const delay = failures >= LONG_OUTAGE_ATTEMPTS ? Math.max(rung, LONG_OUTAGE_MS) : rung;
            complain(said, delay);
            waiting = true;
            setTimeout(() => void open(), delay);
        };

        const arm = (): void => {
            disarm();
            watchdog = setTimeout(() => {
                /* ABANDONED, not closed politely. A close frame sent to an end that is gone waits on a reply. */
                ws.close(1000, "no heartbeat");
                drop(`nothing heard for ${Math.round(spec.silenceMs / 1000)}s`);
            }, spec.silenceMs);
        };
        // Armed from the DIAL rather than the open, because a socket that never finishes connecting hangs the
        // same way and reads the same from outside: "connecting", forever, with nothing coming.
        arm();
        // Every frame is proof the far end is there, and the hub's heartbeat is what guarantees there are some.
        ws.addEventListener("message", arm);

        ws.addEventListener("open", () => {
            if (dropped) {
                return; // abandoned mid-connect: this socket is already closed and its replacement is on the ladder
            }
            openedAt = Date.now();
            // A link that is up owes nothing to the failures behind it: the next outage is news again, and the
            // "connected to …" line this open is about to log is what reports the recovery.
            failures = 0;
            quietSince = 0;
            failingSince = undefined;
            arm();
            spec.attach(ws);
            const send = (hello: Record<string, unknown>): void => {
                ws.send(JSON.stringify(hello));
                if (attempt.said !== undefined) {
                    spec.log(attempt.said);
                }
            };
            // Sent synchronously when possible so a test can read it the same tick; an async hello still follows.
            const hello = spec.hello();
            if (hello instanceof Promise) {
                void hello.then(send);
            } else {
                send(hello);
            }
        });

        ws.addEventListener("close", (event) => {
            /* A revocation is answered here rather than through `drop`: it is the one close that ends the loop. */
            if (event.code === PEER_UNAUTHORIZED) {
                dropped = true;
                disarm();
                if (socket === ws) {
                    socket = undefined;
                }
                stopping.abort();
                resolveDone();
                spec.revoked();
                return;
            }
            // Named rather than numbered, because this is the code a reader most needs not to mistake for the one
            // above it: the sandbox is up and talking, it just would not admit this socket this time.
            drop(event.code === PEER_TRY_AGAIN ? "the sandbox is not ready to admit this connection yet" : `disconnected (${event.code ?? "no code"})`);
        });

        /* Socket errors record a cause; the close event owns retry scheduling. */
        ws.addEventListener("error", () => {
            if (failures < LOUD_ATTEMPTS) {
                spec.log("connection error");
            }
        });
    };

    void open();

    return {
        done,
        stop: (reason = "stopping") => {
            stopping.abort();
            waiting = false;
            disarmWatchdog();
            // Forgotten before the close frame arrives, so `state` reads closed the moment the peer asked.
            const held = socket;
            socket = undefined;
            held?.close(1000, reason);
            resolveDone();
        },
        state: () => (socket?.readyState === OPEN ? "open" : socket !== undefined || waiting ? "connecting" : "closed"),
        outage: () => (failingSince === undefined ? undefined : { failures, since: failingSince }),
    };
};
