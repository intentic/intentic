/* WHAT A LISTENER REMEMBERS BETWEEN MESSAGES, in memory and best-effort, the three things every chat connector
 * kept for itself in a copy of the same dozen lines. A restart forgets all of it, and each is bounded so a busy
 * workspace cannot grow the gateway's heap: at worst a restart costs one duplicate wake, one empty history,
 * one indicator that stops early. */

// Recent delivery keys, to drop the duplicate delivery when two of our bots share a room and both receive the
// same human message. `duplicate` answers whether the key was already seen, and records it when not.
export interface RecentKeys {
    readonly duplicate: (key: string) => boolean;
}

export const recentKeys = (max: number): RecentKeys => {
    const keys = new Set<string>();
    return {
        duplicate: (key) => {
            if (keys.has(key)) {
                return true;
            }
            keys.add(key);
            if (keys.size > max) {
                const oldest = keys.values().next().value;
                if (oldest !== undefined) {
                    keys.delete(oldest);
                }
            }
            return false;
        },
    };
};

/* The stand-in for a history API on the platforms that have none (Telegram, WhatsApp): what this process has
 * watched go by, per chat, oldest first, bounded per chat and in how many chats are kept. Insertion order is
 * recency (a push re-inserts its chat), so evicting the first key drops the chat quiet longest. */
export interface ChatRings<T> {
    readonly remember: (chat: string, entry: T) => void;
    // What came before, oldest first. A copy: the caller's history is its own to hand on.
    readonly of: (chat: string) => T[];
}

export const chatRings = <T>(limits: { readonly perChat: number; readonly chats: number }): ChatRings<T> => {
    const rings = new Map<string, T[]>();
    return {
        remember: (chat, entry) => {
            const ring = rings.get(chat) ?? [];
            ring.push(entry);
            rings.delete(chat);
            rings.set(chat, ring.slice(-limits.perChat));
            if (rings.size > limits.chats) {
                const quietest = rings.keys().next().value;
                if (quietest !== undefined) {
                    rings.delete(quietest);
                }
            }
        },
        of: (chat) => [...(rings.get(chat) ?? [])],
    };
};

/* A "typing…" heartbeat per room. Every platform's indicator expires on its own after seconds, so it is re-sent
 * on the platform's cadence for the whole turn, and capped so a turn that never replies cannot leak the
 * interval forever. `start` on a room already typing is a continuation (the timer restarts, nothing is said
 * about stopping); `stop` says so through `onStop` where the platform wants a closing word (WhatsApp's
 * "paused" presence), and only for a heartbeat that was live. */
export interface TypingHeartbeat {
    readonly start: (room: string, send: () => void, onStop?: () => void) => void;
    readonly stop: (room: string) => void;
    // Shutdown: every timer goes and nothing is said, the connection a closing word would ride is going too.
    readonly stopAll: () => void;
}

export const typingHeartbeat = (timing: { readonly intervalMs: number; readonly maxMs: number }): TypingHeartbeat => {
    const live = new Map<string, { readonly timer: NodeJS.Timeout; readonly onStop: (() => void) | undefined }>();
    const stop = (room: string): void => {
        const entry = live.get(room);
        if (entry === undefined) {
            return;
        }
        clearInterval(entry.timer);
        live.delete(room);
        entry.onStop?.();
    };
    return {
        stop,
        stopAll: () => {
            for (const entry of live.values()) {
                clearInterval(entry.timer);
            }
            live.clear();
        },
        start: (room, send, onStop) => {
            const previous = live.get(room);
            if (previous !== undefined) {
                clearInterval(previous.timer);
            }
            send();
            const startedAt = Date.now();
            const timer = setInterval(() => {
                if (Date.now() - startedAt > timing.maxMs) {
                    stop(room);
                    return;
                }
                send();
            }, timing.intervalMs);
            live.set(room, { timer, onStop });
        },
    };
};
