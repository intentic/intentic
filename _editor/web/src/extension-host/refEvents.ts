import type { Disposable } from "@intentic/extension-api";

// Fan-out behind api.workspace.onDidChangeRefs: browser-side half of the daemon's refsChanged push.
// Module-level set, not a shallowRef: the sole producer is systemEvents' push handler, and nothing renders from this.
// Separate from contributes.files because the daemon's watcher ignores .git, so a moved ref produces no
// workspaceChanged path to match.

type RefsListener = (repos: readonly string[]) => void;

const listeners = new Set<RefsListener>();

export const onRefsChanged = (listener: RefsListener): Disposable => {
    listeners.add(listener);
    return { dispose: (): void => void listeners.delete(listener) };
};

// One listener throwing must not cost the others their notification.
export const emitRefsChanged = (repos: readonly string[]): void => {
    for (const listener of listeners) {
        try {
            listener(repos);
        } catch (error) {
            console.error(`extension refs listener failed`, error);
        }
    }
};
