/* THE ANNOUNCED HALF OF `runtimeChanged`, for the readers a cache eviction cannot reach.
 *
 * systemEvents routes a runtime frame by invalidating the query keys its domains feed (contract
 * runtime-state.ts), which is the right answer for anything backed by a query and no answer at all for anything
 * that is not. Three of the cards that most need this feed hold plain refs and call the daemon themselves: the
 * host, browser and desktop-sync pairing flows, each of which is a person standing in front of a dialog having
 * just pasted a command into another machine, waiting for it to come up. Every one of them had a three-second
 * timer as its only feed, and the daemon knew the answer the whole time, it is the process the socket connects
 * to.
 *
 * So the same frame that invalidates is also announced, exactly as `workspaceChanged` is for the rail badges
 * (extension-host/fileEvents.ts). This is the host handing the daemon's own declaration back as an event rather
 * than only as a cache eviction, and it is deliberately a small door: a listener names the domains it cares
 * about and hears nothing else.
 *
 * A module-level set rather than a `shallowRef`, for fileEvents' reason: the sole producer is systemEvents'
 * push handler, which is imperative and fires per frame, and nothing renders from it. */

type RuntimeListener = () => void;

interface Subscription {
    // The domain names this listener wants, matched exactly. Wire strings rather than the RuntimeDomain union:
    // the daemon may be newer than this build, and an unknown name simply matches nobody.
    readonly domains: readonly string[];
    readonly listener: RuntimeListener;
}

const subscriptions = new Set<Subscription>();

/** Wake `listener` whenever the daemon says one of `domains` moved. Returns its own unsubscribe, which callers
 *  hold for as long as the dialog or card is open, the same lifetime the timer this replaced had. */
export const onRuntimeChanged = (domains: readonly string[], listener: RuntimeListener): (() => void) => {
    const entry: Subscription = { domains, listener };
    subscriptions.add(entry);
    return () => void subscriptions.delete(entry);
};

/* Announce one frame's domains. One listener throwing must not cost the others their notification, the same
 * containment every other fan-out in this app gets, and a card that fails to refresh itself is not a reason for
 * the card beside it to stop hearing about its machine. */
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
