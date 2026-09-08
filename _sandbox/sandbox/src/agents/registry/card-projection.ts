// Live per-conversation values (loop iteration, workflow position) owned by a runner, not the registry entry, avoiding
// an import cycle. onChange notifies since these change between turns; forget removes entries when the agent is
// discarded.

export interface CardProjection<T> {
    // What the roster should say about this conversation; undefined for the majority that never did this.
    readonly of: (conversationId: string) => T | undefined;
    readonly set: (conversationId: string, projection: T) => void;
    // Removes projections for ids the registry's `remove` is also discarding.
    readonly forget: (conversationIds: readonly string[]) => void;
    // Subscribes to changes; returns the unsubscribe. Only the registry subscribes, to republish the roster.
    readonly onChange: (listener: () => void) => () => void;
}

export const cardProjection = <T>(): CardProjection<T> => {
    const live = new Map<string, T>();
    const listeners = new Set<() => void>();
    return {
        of: (conversationId) => live.get(conversationId),
        set: (conversationId, projection) => {
            live.set(conversationId, projection);
            for (const listener of listeners) {
                listener();
            }
        },
        forget: (conversationIds) => {
            for (const id of conversationIds) {
                live.delete(id);
            }
        },
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
};
