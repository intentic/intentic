import { type QueryClient, QueryObserver } from "@tanstack/vue-query";

// Views on screen as the cache sees them: each key seeded with data and held by an observer, counting every read its
// queryFn is asked for, which is the number of requests a frame costs the daemon.
export const viewsOnScreen = (
    client: QueryClient,
    keys: readonly (readonly unknown[])[],
): { readonly reads: (key: readonly unknown[]) => number; readonly unmount: () => void } => {
    const counts = new Map<string, number>();
    const unsubscribes = keys.map((queryKey) => {
        const id = JSON.stringify(queryKey);
        client.setQueryData([...queryKey], { from: `cache` });
        const observer = new QueryObserver(client, {
            queryKey: [...queryKey],
            queryFn: async () => {
                counts.set(id, (counts.get(id) ?? 0) + 1);
                return { from: `daemon` };
            },
        });
        return observer.subscribe(() => undefined);
    });
    return {
        reads: (key) => counts.get(JSON.stringify(key)) ?? 0,
        unmount: () => {
            for (const unsubscribe of unsubscribes) {
                unsubscribe();
            }
            for (const queryKey of keys) {
                client.removeQueries({ queryKey: [...queryKey], exact: true });
            }
        },
    };
};
