import type { Disposable } from "@intentic/extension-api";

/* THE FAN-OUT BEHIND `api.workspace.onDidChangeRefs` — the browser-side half of the daemon's `refsChanged`
 * push.
 *
 * A module-level listener set rather than a `shallowRef`, for the same reason fileBindings.ts is a plain map:
 * the sole producer is systemEvents' push handler, which is imperative and fires per frame, and nothing renders
 * from this. Extensions turn the callback into whatever invalidation their own caches need.
 *
 * It is a separate channel from `contributes.files` because no file contribution could carry it — the daemon's
 * watcher descent-ignores `.git`, so a moved ref produces no `workspaceChanged` path for a prefix to match. */

type RefsListener = (repos: readonly string[]) => void;

const listeners = new Set<RefsListener>();

export const onRefsChanged = (listener: RefsListener): Disposable => {
    listeners.add(listener);
    return { dispose: (): void => void listeners.delete(listener) };
};

// One listener throwing must not cost the others their notification — the same containment every other
// extension callback the host invokes gets, and for the same reason.
export const emitRefsChanged = (repos: readonly string[]): void => {
    for (const listener of listeners) {
        try {
            listener(repos);
        } catch (error) {
            console.error(`extension refs listener failed`, error);
        }
    }
};
