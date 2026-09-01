/* IS THE PEER STILL THERE, which TCP will not tell you in any useful time.
 *
 * A sandbox's tunnel is mostly idle — a workspace nobody is looking at sends nothing for hours — so "the
 * socket has not errored" is not evidence of anything. A container that was killed, a laptop that slept, a NAT
 * that dropped the mapping: all three leave a socket that looks open from here and will never deliver another
 * byte. The registration behind it keeps answering routes for a box that is gone, which is a 502 the browser
 * waits the full proxy timeout for instead of the immediate one it should get.
 *
 * So the edge asks: a WebSocket ping every interval, and a peer that has said NOTHING (pong, frame, anything)
 * for the dead window is unregistered and its socket closed. The numbers are the contract's.
 *
 * Split from the socket so it is a state machine rather than a timer: `tick` is one interval elapsing, and the
 * tests drive it directly instead of waiting out real seconds or reaching for fake timers.
 */

// The contract's numbers: ping every 15s, dead after 45s of silence. Three missed intervals rather than one,
// because a single dropped pong is ordinary on a congested link and tearing a working tunnel down for it
// would be the more expensive mistake.
export const PING_INTERVAL_MS = 15_000;
export const DEAD_AFTER_MS = 45_000;

export interface HeartbeatOptions {
    readonly ping: () => void;
    readonly onDead: () => void;
    readonly now?: () => number;
    readonly deadAfterMs?: number;
}

export interface Heartbeat {
    // The peer said something. Any frame counts, not just a pong: a tunnel carrying traffic is alive by
    // definition, and requiring the pong specifically would kill busy sessions on a lost control frame.
    readonly saw: () => void;
    // One interval elapsed: declare the peer dead, or ping it.
    readonly tick: () => void;
    readonly stop: () => void;
    readonly alive: () => boolean;
}

export const createHeartbeat = (options: HeartbeatOptions): Heartbeat => {
    const now = options.now ?? Date.now;
    const deadAfterMs = options.deadAfterMs ?? DEAD_AFTER_MS;
    let lastSeen = now();
    let stopped = false;

    return {
        saw: () => {
            lastSeen = now();
        },
        tick: () => {
            if (stopped) {
                return;
            }
            /* Declared dead BEFORE pinging, so a peer that has gone quiet is not sent one more frame it will
             * never answer. The order also makes the window exact: the first tick past the deadline ends it. */
            if (now() - lastSeen > deadAfterMs) {
                stopped = true;
                options.onDead();
                return;
            }
            options.ping();
        },
        stop: () => {
            stopped = true;
        },
        alive: () => !stopped,
    };
};

// The same thing wired to a real clock. Unrefed so a heartbeat can never be the reason this process stays up.
export const startHeartbeat = (options: HeartbeatOptions & { readonly intervalMs?: number }): Heartbeat => {
    const heartbeat = createHeartbeat(options);
    const timer = setInterval(() => heartbeat.tick(), options.intervalMs ?? PING_INTERVAL_MS);
    timer.unref?.();
    return {
        ...heartbeat,
        stop: () => {
            clearInterval(timer);
            heartbeat.stop();
        },
    };
};
