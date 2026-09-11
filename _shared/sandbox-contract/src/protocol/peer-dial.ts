// The one outbound socket a peer (machine agent, webext, runner) holds to its sandbox: hello carries the enrollment
// token in the frame, then the link is pure oRPC. Reconnects on backoff after any drop except a revoked enrollment
// (code 1008), which never retries.

// Reconnect backoff: fast floor for a restart, low cap so a reopened laptop is back within a minute.
export const PEER_LINK_BACKOFF = { floorMs: 1_000, capMs: 30_000, stableMs: 60_000 } as const;

/* HOW MUCH A LINK THAT CANNOT BE REACHED IS ALLOWED TO SAY, which is a different question from how often it
 * may try. At the cap above, a far end that is gone for good — a sandbox deleted, a tunnel pointed elsewhere —
 * costs two lines every 30 seconds for as long as the machine is on: 5,760 a day. One laptop's agent had
 * written 1,992 pairs of them, 2.3 MB, and this log is exactly where its owner had been sent to read why a
 * DIFFERENT thing had failed; the answer was in there, under an hour of repetition.
 *
 * The cadence is not the problem and is deliberately untouched — a reopened laptop must be back within a
 * minute, which is what the low cap buys. The REPETITION is. So the first few failures are reported in full,
 * then the loop says so once more to mark that it is going quiet, and after that repeats itself at most once
 * per QUIET_LOG_MS with the attempt count that says how long it has been trying. A link that opens resets all
 * of it: every reconnect is news, and the reconnect line is what reports it. */
const LOUD_ATTEMPTS = 3;
const QUIET_LOG_MS = 10 * 60_000;

/* HOW LONG A SOCKET MAY SAY NOTHING before this side calls the link dead, as a multiple of the door's own
 * heartbeat: the hub pings every live peer on an interval (peer-hub.ts), so a socket with nothing on it for
 * three heartbeats is not quiet, it is gone.
 *
 * WHY A PEER NEEDS THIS AT ALL — a close event is not guaranteed, and the loop below has nothing else to react
 * to. The socket that taught us is a loopback one: a machine agent dialling a sandbox container on its own
 * machine through Docker Desktop's port relay. The container was recreated; the relay was not, so it held the
 * agent's TCP connection open with nothing behind it. No FIN, no error, no close event — the agent held an open
 * socket to a daemon that had never heard of it for 25 hours, its Devices card offline the whole time, every
 * control on that card dead, and the only cure anyone found was re-running setup by hand. Any path with a
 * middlebox in it (a NAT, a tunnel, a userland proxy, a laptop's suspended wifi) can do this to a socket with
 * nothing to say, and the middlebox is never the side that notices. The peer is. */
export const PEER_LINK_SILENCE_HEARTBEATS = 3;
export const peerLinkSilenceMs = (heartbeatMs: number): number => heartbeatMs * PEER_LINK_SILENCE_HEARTBEATS;

// The sandbox closes with this when the token is not enrolled: a decision, not a fault, and one that never heals.
const UNAUTHORIZED = 1008;

// WebSocket spec's readyState value for open, named so a fake socket need not import the real class.
const OPEN = 1;

// Structural interface a browser's WebSocket, node's global one, and a test's fake all satisfy without a cast.
export interface SocketLike {
    readonly readyState: number;
    /* `message` is here for the watchdog alone, which needs no more than the fact that one arrived: what is IN
     * the frames belongs to the oRPC handler `attach` hands the socket to, and a listener added here does not
     * take it from that one (both runtimes' sockets fan an event out to every listener). */
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
    /* How long this socket may hear nothing before the link is presumed dead: `peerLinkSilenceMs` of the
     * heartbeat the door's own hub pings on. Required rather than defaulted, because the number belongs to the
     * door and a peer that quietly inherited someone else's would be guessing about the one deadline that
     * decides whether it ever notices a dead link. */
    readonly silenceMs: number;
    readonly log: (message: string) => void;
    // Sandbox refused the enrollment (1008); the loop has already stopped, this is where the peer says so.
    readonly revoked: () => void;
}

// What the socket is doing right now. "connecting" covers a dial in flight and a retry waiting on the ladder:
// nobody should start another. Named, because processes that are not this one report it (a machine agent stamps
// it for `status`, which otherwise has only the link list on disk and no idea whether any of it is up).
export type PeerLinkState = "open" | "connecting" | "closed";

export interface PeerLink {
    // Resolves when the loop is asked to stop or refused for good; never rejects, a connection error is a retry.
    readonly done: Promise<void>;
    readonly stop: (reason?: string) => void;
    readonly state: () => PeerLinkState;
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

    /* What ONE failed attempt is allowed to say. Three sentences rather than one repeated forever: the first few
     * failures in full, then the line that marks the loop going quiet (so a reader who sees it knows the retries
     * continue unlogged), then a complaint carrying the attempt count at most once per window. */
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

        /* THIS ATTEMPT'S DROP, taken by whichever side notices first: the far end's close frame, or the
         * watchdog. Latched, because a socket the watchdog abandoned may still emit its close minutes later,
         * and two redials on one link is two loops racing to hold the same door. */
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
            const delay = spec.backoff.next(openedAt === undefined ? 0 : Date.now() - openedAt);
            openedAt = undefined;
            failures += 1;
            complain(said, delay);
            waiting = true;
            setTimeout(() => void open(), delay);
        };

        const arm = (): void => {
            disarm();
            watchdog = setTimeout(() => {
                /* ABANDONED, not closed politely. A close frame sent to an end that is gone waits on a reply
                 * that never comes — CLOSING is the state this watchdog exists to escape — so `close` is called
                 * for the runtime's sake and the redial does not wait on an event that may never fire. */
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
            /* A revocation is answered here rather than through `drop`: it is the one close that ends the loop
             * instead of feeding the ladder, and it must still land on a socket the watchdog abandoned first —
             * an owner who revoked a peer has said so, whether or not this side had already given up on it. */
            if (event.code === UNAUTHORIZED) {
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
            drop(`disconnected (${event.code ?? "no code"})`);
        });

        /* Always followed by a close event that owns the retry; this only records a cause the close code can't
         * carry, so it is silenced with the rest once the loop goes quiet — it is half of every repeated pair in
         * a dead link's log, and it says nothing the drop line beside it does not. The attempt that finally
         * reconnects is loud again, this line included. */
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
    };
};
