/* THE ONE SOCKET a peer holds to its sandbox, written once for the three things that hold one: the machine
 * agent (@intentic/machine), the browser extension (@intentic/webext) and a runner (the daemon itself, in
 * runner mode). Each dials OUT, sends a plain-JSON hello carrying its enrollment token (host-protocol.ts,
 * webext-protocol.ts, runner-protocol.ts), and from then on everything the sandbox asks arrives on the socket
 * as oRPC against the door's contract, with the PEER serving.
 *
 * OUTBOUND ONLY, and that is the entire networking story: no port is opened, no router configured, no VPN
 * joined. A laptop on hotel wifi behind a corporate proxy holds this connection because it is an ordinary
 * outbound wss://, the same thing every chat app on the machine is already doing.
 *
 * The socket has exactly two phases. First the hello, plain JSON, because the sandbox has nothing to call until
 * it knows whose socket this is (the token rides the FRAME, never the URL, which would write a durable key into
 * every proxy log between the peer and the sandbox). Then the sandbox attaches its client and the socket is pure
 * oRPC: request/response correlation, argument validation and error shape all belong to the link from that
 * point on, which is why there is no message plumbing here.
 *
 * THE HANDLER IS ATTACHED BEFORE THE HELLO GOES OUT: the sandbox may call the moment it has verified the token,
 * and a race there would drop the first `setScopes`, the one call whose loss would leave a device enforcing a
 * stale grant.
 *
 * RECONNECTION IS THE NORMAL CASE, not the failure case. Lids close, wifi changes, tunnels idle out, sandboxes
 * restart on every rebuild. So a dropped socket is routine and comes back on an exponential ladder the caller
 * supplies (@intentic/base's createBackoff, over PEER_LINK_BACKOFF): a link that held for a minute was working
 * and its drop redials at the floor; one that opened and died at once keeps climbing. The one thing that is NOT
 * retried is a refused enrollment (close code 1008): the owner revoked this peer, that never heals on its own,
 * and hammering a door that has been locked is how an agent turns a revocation into a support ticket.
 *
 * Here, in the contract, beside the hello schemas it sends and the URL builders it dials, rather than in a
 * package of its own: every peer already depends on this one, and the loop is the far end of the same wire. */

// Backoff bounds. The first retry is fast because the overwhelmingly common cause is a sandbox restart, which
// takes seconds; the ceiling is low enough that a laptop opened after a night asleep is back within a minute.
export const PEER_LINK_BACKOFF = { floorMs: 1_000, capMs: 30_000, stableMs: 60_000 } as const;

// The sandbox closes with this when the token is not enrolled: a decision, not a fault, and one that never heals.
const UNAUTHORIZED = 1008;

// A socket's readyState value for "open", per the WebSocket spec, named so a caller's fake need not import a class.
const OPEN = 1;

// What the two runtimes' sockets have in common, taken structurally: a browser's WebSocket, node's global one,
// and a test's fake all satisfy it without a cast.
export interface SocketLike {
    readonly readyState: number;
    addEventListener(type: "open" | "close" | "error", listener: (event: { readonly code?: number }) => void): void;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

export interface PeerDialSpec<S extends SocketLike> {
    /* ONE ATTEMPT'S SOCKET, dialled at whatever address the caller resolves for THIS attempt: a sandbox on the
     * same machine is a loopback hop away on one attempt and behind its tunnel on the next, and asking on every
     * attempt rather than once at startup is exactly what a reconnect is about. `said` is the line the log gets
     * once the socket is open. Undefined ⇒ there is nothing to dial any more (the pairing was forgotten), and
     * the loop ends. `signal` is aborted by `stop`, so a resolution that outlives the stop opens nothing. */
    readonly open: (signal: AbortSignal) => Promise<{ readonly socket: S; readonly said?: string } | undefined>;
    // The first frame, carrying the enrollment token and whatever the door's hello schema asks for.
    readonly hello: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    // Hand the open socket to the oRPC handler serving the door's contract.
    readonly attach: (socket: S) => void;
    // The retry ladder: how long to wait after a drop, given how long the socket had held.
    readonly backoff: { readonly next: (heldMs: number) => number };
    readonly log: (message: string) => void;
    // The sandbox refused the enrollment (1008). The loop has already stopped; this is where the peer says so.
    readonly revoked: () => void;
}

export interface PeerLink {
    // Resolves when the loop is asked to stop or refused for good; never rejects, a connection error is a retry.
    readonly done: Promise<void>;
    readonly stop: (reason?: string) => void;
    // "connecting" covers a dial in flight AND a retry waiting on the ladder: both mean nobody should start another.
    readonly state: () => "open" | "connecting" | "closed";
}

export const dialPeer = <S extends SocketLike>(spec: PeerDialSpec<S>): PeerLink => {
    const stopping = new AbortController();
    let socket: S | undefined;
    let waiting = false;
    let openedAt: number | undefined;
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });

    const open = async (): Promise<void> => {
        waiting = true;
        const attempt = await spec.open(stopping.signal);
        waiting = false;
        // Stopped while the address was still being decided: there is nothing to open, and `stop` has already
        // settled `done`. A socket a slow resolver still handed over is closed rather than left dialling.
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

        ws.addEventListener("open", () => {
            openedAt = Date.now();
            spec.attach(ws);
            const send = (hello: Record<string, unknown>): void => {
                ws.send(JSON.stringify(hello));
                if (attempt.said !== undefined) {
                    spec.log(attempt.said);
                }
            };
            // Sent in the open handler's own tick where the hello is already in hand: the sandbox's auth
            // deadline is generous, but a frame that could go now and waits a tick is a frame a test cannot
            // read, and a hello that needs a read first (a runner's settings claim) simply follows it.
            const hello = spec.hello();
            if (hello instanceof Promise) {
                void hello.then(send);
            } else {
                send(hello);
            }
        });

        ws.addEventListener("close", (event) => {
            socket = undefined;
            if (stopping.signal.aborted) {
                resolveDone();
                return;
            }
            if (event.code === UNAUTHORIZED) {
                stopping.abort();
                resolveDone();
                spec.revoked();
                return;
            }
            const delay = spec.backoff.next(openedAt === undefined ? 0 : Date.now() - openedAt);
            openedAt = undefined;
            spec.log(`disconnected (${event.code ?? "no code"}); reconnecting in ${Math.round(delay / 1000)}s`);
            waiting = true;
            setTimeout(() => void open(), delay);
        });

        // A socket error is always followed by a close event, which owns the retry; this only records the cause,
        // which the close code alone never carries.
        ws.addEventListener("error", () => spec.log("connection error"));
    };

    void open();

    return {
        done,
        stop: (reason = "stopping") => {
            stopping.abort();
            waiting = false;
            // Forgotten before the close frame arrives, so `state` reads closed the moment the peer asked.
            const held = socket;
            socket = undefined;
            held?.close(1000, reason);
            resolveDone();
        },
        state: () => (socket?.readyState === OPEN ? "open" : socket !== undefined || waiting ? "connecting" : "closed"),
    };
};
