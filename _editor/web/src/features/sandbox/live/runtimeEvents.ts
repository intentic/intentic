// The announced half of `runtimeChanged`, for readers a cache eviction can't reach: pairing/host/browser dialogs with
// plain refs that used to poll the daemon on a timer. A listener names the domains it wants; a module-level set, not a
// `shallowRef`, since the sole producer fires per frame.

type RuntimeListener = () => void;

interface Subscription {
    // The domain names this listener wants, matched exactly; wire strings since the daemon may be newer.
    readonly domains: readonly string[];
    readonly listener: RuntimeListener;
}

const subscriptions = new Set<Subscription>();

/** Wakes `listener` whenever the daemon says one of `domains` moved; returns its own unsubscribe. */
export const onRuntimeChanged = (domains: readonly string[], listener: RuntimeListener): (() => void) => {
    const entry: Subscription = { domains, listener };
    subscriptions.add(entry);
    return () => void subscriptions.delete(entry);
};

// Announces one frame's domains; one listener throwing must not cost the others their notification.
export const emitRuntimeChanged = (domains: readonly string[]): void => {
    for (const { domains: wanted, listener } of subscriptions) {
        if (!wanted.some((domain) => domains.includes(domain))) {
            continue;
        }
        try {
            listener();
        } catch (error) {
            console.error(`runtime listener failed`, error);
        }
    }
};
