// Detects a tunnel peer TCP won't report as gone (a killed container, a dropped NAT mapping, a host that slept), from
// both ends: the edge forgets a silent sandbox and the sandbox redials a silent edge, and only each end can do its half.
// A state machine, not a timer, so `tick` (one interval) can be driven directly by tests.

// Ping every 15s, dead after three missed intervals (45s); one miss alone is ordinary on a congested link.
export const PING_INTERVAL_MS = 15_000;
export const DEAD_AFTER_MS = 45_000;

export interface HeartbeatOptions {
    readonly ping: () => void;
    readonly onDead: () => void;
    readonly now?: () => number;
    readonly deadAfterMs?: number;
}

export interface Heartbeat {
    // Peer said something; any frame counts, since a busy tunnel is alive even if it drops a pong.
    readonly saw: () => void;
    // One interval elapsed: ping the peer, or declare it dead.
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
            // Declared dead before pinging: a peer already quiet gets no extra frame, and the deadline window stays
            // exact.
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

// Wired to a real clock; unrefed so a heartbeat never keeps the process alive.
export const startHeartbeat = (options: HeartbeatOptions & { readonly intervalMs?: number }): Heartbeat => {
    const heartbeat = createHeartbeat(options);
    const timer = setInterval(() => heartbeat.tick(), options.intervalMs ?? PING_INTERVAL_MS);
    timer.unref();
    return {
        ...heartbeat,
        stop: () => {
            clearInterval(timer);
            heartbeat.stop();
        },
    };
};
