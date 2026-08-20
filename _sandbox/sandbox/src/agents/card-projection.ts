/* A LIVE FACT THE FLEET CARD CARRIES, kept beside the roster instead of inside it.
 *
 * Some things a card has to say are not properties of a conversation at all, they belong to the machine
 * DRIVING it. A loop's iteration count, a workflow run's position in its graph: both are owned by a runner that
 * reaches Services, git and the turn generator, and neither can be stored on the registry entry without the
 * registry importing that world and closing a cycle on its way round. So the runner publishes here and the
 * registry reads by function call, the pattern agent/subagents.ts set, generalised the once it was needed
 * twice.
 *
 * THE CHANGE NOTIFICATION is what these have over a plain map, and it earns its place on a case the subagent
 * counts don't have. A subagent's count only moves DURING a turn, and every turn frame broadcasts the roster
 * anyway, so the counts ride out for free. The state changes that matter most here happen BETWEEN turns, the
 * last iteration's `finish` has already broadcast, and only then does the pump decide the goal is met; a step
 * settles and only then does the step after it start. Without a notification the card would hold
 * `running · iteration 12/12` until something unrelated moved the fleet, which is precisely the moment someone
 * is watching it.
 *
 * NOTHING IS PRUNED WHEN THE WORK ENDS. A finished loop is what its card is read for afterwards ("stalled after
 * 4"), these are one small entry per conversation, and `forget` takes them when the agent is discarded.
 *
 * The module imports nothing at all, which is the whole point: everything downstream of the registry can reach
 * a projection without dragging a runner in behind it.
 */

export interface CardProjection<T> {
    // What the roster should say about this conversation; undefined for the majority that never did this.
    readonly of: (conversationId: string) => T | undefined;
    readonly set: (conversationId: string, projection: T) => void;
    // Forget projections for agents that no longer exist, the registry's own `remove` (discard, archive purge)
    // calls it with the same ids, so a conversation cannot leave one behind.
    readonly forget: (conversationIds: readonly string[]) => void;
    // Subscribe to changes; returns the unsubscribe. The registry is the only subscriber, it re-publishes the
    // roster, which is the entire point of the notification.
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
