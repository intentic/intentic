import type { Disposable } from "@intentic/extension-api";

// Fan-out behind api.workspace.onDidChangeFiles: browser-side half of the daemon's workspaceChanged push, for extension
// work that isn't mounted on screen.
// Scoped to each subscriber's own declared contributes.files paths, matched by prefix; not a channel onto the rest of
// the workspace's traffic.
// Module-level set, not a shallowRef: the sole producer is systemEvents' push handler, which is imperative and fires
// per frame.

type FilesListener = (paths: readonly string[]) => void;

interface Subscription {
    // Declared contributes.files paths, matched by prefix the same way staleQueryKeys matches.
    readonly paths: readonly string[];
    readonly listener: FilesListener;
}

const subscriptions = new Set<Subscription>();

export const onFilesChanged = (paths: readonly string[], listener: FilesListener): Disposable => {
    const entry: Subscription = { paths, listener };
    subscriptions.add(entry);
    return { dispose: (): void => void subscriptions.delete(entry) };
};

// Announces one batch. An empty batch means "something changed, unspecified" (daemon capped, or reconnecting) and wakes
// every subscriber for its own paths.
// One listener throwing must not cost the others their notification.
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
