// Single-use credentials this daemon has accepted, each remembered until it would have expired anyway (plus a minute
// of clock skew), so the memory a flood of them costs ends with their lives. In memory: a restart forgets, and the
// credentials it covers live minutes, never across the time a restart takes to matter.
export const spentOnce = () => {
    const spent = new Map<string, number>();
    return {
        // Whether this is the first time `key` is spent, recording it if so.
        spend: (key: string, expiresAtMs: number, nowMs: number): boolean => {
            for (const [seen, until] of spent) {
                if (until <= nowMs) {
                    spent.delete(seen);
                }
            }
            if (spent.has(key)) {
                return false;
            }
            spent.set(key, expiresAtMs + 60_000);
            return true;
        },
    };
};
