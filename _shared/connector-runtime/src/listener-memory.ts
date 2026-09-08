// What a listener remembers between messages: recent delivery keys, per-chat history stand-ins, typing heartbeats.
// Bounded and best-effort; a restart forgets all of it.

// Recent delivery keys; drops a duplicate when two bots share a room and see the same message. `duplicate` reports and
// records.
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

// Stand-in history for platforms with no history API (Telegram, WhatsApp): recent messages per chat, oldest first,
// bounded per chat and in chats kept. Insertion order is recency; eviction drops the quietest chat.
export interface ChatRings<T> {
    readonly remember: (chat: string, entry: T) => void;
    // Oldest first; a copy, so the caller may keep or mutate it freely.
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

// Per-room "typing…" heartbeat, re-sent on cadence since each indicator expires on its own; capped so a stalled turn
// can't leak it. `start` on a live room continues it; `stop` fires `onStop` only if it was live.
export interface TypingHeartbeat {
    readonly start: (room: string, send: () => void, onStop?: () => void) => void;
    readonly stop: (room: string) => void;
    // Clears every timer without firing onStop.
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
