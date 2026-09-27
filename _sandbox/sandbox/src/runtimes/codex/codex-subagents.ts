// Codex's own subagents (its multi-agent tools, on by default). A spawn call starts a thread of its own on the same
// app-server connection, and that thread's turn, items, usage and ending arrive there too, carrying its thread id. The
// connection is this turn's alone (one app-server per turn), so every thread on it other than the turn's own belongs to
// a subagent the turn started. The spawn call names the thread it started only as it completes, often after the thread
// has already begun, so what a thread sends before it is named waits here and is replayed once it is.

// Notifications held per unnamed thread; past this a thread that is never named has said all it will be heard for.
const HELD_PER_THREAD = 1_000;

export interface CodexSubagentThreads<N> {
    // Where a notification from `thread` goes: the turn's own, the spawn call whose subagent's it is, or held.
    readonly route: (thread: string, notification: N) => { readonly kind: "own" } | { readonly kind: "subagent"; readonly spawn: string } | { readonly kind: "held" };
    // A spawn call named the threads it started; returns what they sent before, to be read as theirs now.
    readonly named: (spawn: string, threads: readonly string[]) => readonly { readonly spawn: string; readonly notification: N }[];
}

export const codexSubagentThreads = <N>(own: string): CodexSubagentThreads<N> => {
    const spawnOf = new Map<string, string>();
    const held = new Map<string, N[]>();
    return {
        route: (thread, notification) => {
            if (thread === own) {
                return { kind: "own" };
            }
            const spawn = spawnOf.get(thread);
            if (spawn !== undefined) {
                return { kind: "subagent", spawn };
            }
            const waiting = held.get(thread) ?? [];
            if (waiting.length < HELD_PER_THREAD) {
                waiting.push(notification);
            }
            held.set(thread, waiting);
            return { kind: "held" };
        },
        named: (spawn, threads) =>
            threads.flatMap((thread) => {
                if (thread === own || spawnOf.has(thread)) {
                    return [];
                }
                spawnOf.set(thread, spawn);
                const waiting = held.get(thread) ?? [];
                held.delete(thread);
                return waiting.map((notification) => ({ spawn, notification }));
            }),
    };
};
