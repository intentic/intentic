import type { Disposable } from "@intentic/extension-api";

// Fan-out behind api.workspace.onDidChangeRefs and onDidChangeRepos: the browser-side half of the daemon's refsChanged
// and reposChanged pushes. Neither fact is a file path the watcher reports (it ignores .git), so contributes.files
// cannot carry them. Module-level sets, not shallowRefs: the sole producer is systemEvents' push handler.

type ReposListener = (repos: readonly string[]) => void;

const fanOut = (label: string): { on: (listener: ReposListener) => Disposable; emit: (repos: readonly string[]) => void } => {
    const listeners = new Set<ReposListener>();
    return {
        on: (listener) => {
            listeners.add(listener);
            return { dispose: (): void => void listeners.delete(listener) };
        },
        // One listener throwing must not cost the others their notification.
        emit: (repos) => {
            for (const listener of listeners) {
                try {
                    listener(repos);
                } catch (error) {
                    console.error(`extension ${label} listener failed`, error);
                }
            }
        },
    };
};

// Which repos' refs moved (commit, checkout, branch, tag, rebase).
const refs = fanOut(`refs`);
export const onRefsChanged = refs.on;
export const emitRefsChanged = refs.emit;

// The whole repository set, after a clone, scaffold or delete changed it.
const repoSet = fanOut(`repos`);
export const onReposChanged = repoSet.on;
export const emitReposChanged = repoSet.emit;
