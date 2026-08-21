import type { Disposable } from "@intentic/extension-api";

/* THE FAN-OUT BEHIND `api.workspace.onDidChangeFiles`, the browser-side half of the daemon's `workspaceChanged`
 * push, aimed at the work an extension does while none of it is on screen.
 *
 * `contributes.files` already existed and already reached the right place: the host invalidates the query keys a
 * changed path feeds (systemEvents.ts). But invalidation only reaches a query something is OBSERVING, and the
 * one thing that reads a badge's data has nothing mounted by definition, so every rail tile in the workspace was
 * left with a timer as its only feed. A queue the owner had just emptied went on claiming six items until the
 * next tick, and for the slowest of those tiles that tick is ten minutes away.
 *
 * So the same frame that invalidates is also announced, and a poll can wake on it (extension-api/background.ts).
 * The declaration does not change: an extension already said which paths its views derive from, and this is the
 * host handing that declaration back as an event instead of only as a cache eviction.
 *
 * SCOPED TO THE SUBSCRIBER'S OWN PATHS. The listener is registered with the prefixes from that extension's
 * manifest, so nobody writes prefix matching twice and nobody is woken by a write they never claimed, which also
 * means this is not a door onto the rest of the workspace's traffic.
 *
 * A module-level set rather than a `shallowRef`, for the same reason fileBindings.ts is a plain map: the sole
 * producer is systemEvents' push handler, which is imperative and fires per frame, and nothing renders from it. */

type FilesListener = (paths: readonly string[]) => void;

interface Subscription {
    // The extension's declared `contributes.files` paths, matched by prefix exactly as staleQueryKeys matches.
    readonly paths: readonly string[];
    readonly listener: FilesListener;
}

const subscriptions = new Set<Subscription>();

export const onFilesChanged = (paths: readonly string[], listener: FilesListener): Disposable => {
    const entry: Subscription = { paths, listener };
    subscriptions.add(entry);
    return { dispose: (): void => void subscriptions.delete(entry) };
};

/* Announce one batch of changed paths.
 *
 * AN EMPTY BATCH MEANS "SOMETHING, AND WE CANNOT SAY WHAT", and it is a real frame rather than a degenerate one:
 * the daemon sends no path list at all past MAX_PATHS (a branch switch, a codegen run, a mass delete), and it is
 * also how a reconnect says "frames may have been lost while you were away". Both wake every subscriber for its
 * own declared paths, because the alternative is the exact failure this channel exists to remove: the one class
 * of change large enough to matter arriving as the one frame nobody reacts to.
 *
 * One listener throwing must not cost the others their notification, the same containment every other extension
 * callback the host invokes gets. */
export const emitFilesChanged = (changed: readonly string[]): void => {
    for (const { paths, listener } of subscriptions) {
        const matched = changed.length === 0 ? paths : changed.filter((path) => paths.some((prefix) => path.startsWith(prefix)));
        if (matched.length === 0) {
            continue;
        }
        try {
            listener(matched);
        } catch (error) {
            console.error(`extension files listener failed`, error);
        }
    }
};
