import { type FSWatcher, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { createIgnoreScope, type IgnoreScope, toRelPath, walkMatchers } from "@intentic/workspace-ignore";
import { TEMPORARY_MARK } from "./files.js";

// What moved on disk under a folder, batched the way the daemon batches /work (250 ms) and handed out as root-relative
// paths; an empty batch means "something moved, refetch it all". Windows and macOS watch a whole tree natively. Linux
// watches one folder at a time, so there only the folders the explorer would open are watched: ignored ones
// (node_modules, .git, build output) are skipped, up to a cap, and a folder that appears later is picked up as it does.
// A folder past the cap still shows what changed in it the next time the explorer lists it.

const BATCH_MS = 250;

// Linux's per-folder watches: the tree walk's own entry budget bounds what anyone can see, and this bounds what is kept
// open behind it, well under the smallest default inotify allowance.
const MAX_LINUX_WATCHES = 4000;

export interface FolderWatch {
    readonly close: () => void;
}

// A path this side wrote on its way to a save, which the save's own rename reports as the change it is.
const ownDebris = (path: string): boolean => path.includes(TEMPORARY_MARK);

// Changes gathered for one flush: a path, or undefined for "something moved, no telling what".
interface Batch {
    readonly add: (path: string | undefined) => void;
    readonly stop: () => void;
}

const batcher = (onChange: (paths: readonly string[]) => void): Batch => {
    let pending: Set<string> | undefined;
    let everything = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
        timer = undefined;
        const paths = everything ? [] : [...(pending ?? [])];
        pending = undefined;
        everything = false;
        onChange(paths);
    };
    return {
        add: (path) => {
            if (path !== undefined && ownDebris(path)) {
                return;
            }
            if (path === undefined) {
                everything = true;
            } else {
                (pending ??= new Set()).add(path);
            }
            timer ??= setTimeout(flush, BATCH_MS);
        },
        stop: () => {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        },
    };
};

// The whole tree under one native watch.
const watchRecursively = (root: string, add: (path: string | undefined) => void, log: (line: string) => void): FSWatcher | undefined => {
    try {
        return watch(root, { recursive: true }, (_event, name) => add(name === null ? undefined : String(name).split(`\\`).join(`/`))).on(`error`, (error) =>
            log(`watching ${root} stopped: ${error.message}`),
        );
    } catch (error) {
        log(`cannot watch ${root}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
};

// One watch per folder the explorer would open, discovered breadth first and grown as folders appear.
const watchFolders = (root: string, add: (path: string | undefined) => void, log: (line: string) => void): FolderWatch => {
    const watchers = new Map<string, FSWatcher>();
    let closed = false;
    let capped = false;
    const watchDir = async (rel: string, scope: IgnoreScope): Promise<void> => {
        if (closed || watchers.has(rel)) {
            return;
        }
        if (watchers.size >= MAX_LINUX_WATCHES) {
            if (!capped) {
                capped = true;
                log(`${root} has more folders than are watched (${MAX_LINUX_WATCHES}); changes deeper in it show when the explorer lists them`);
            }
            return;
        }
        const abs = rel === `` ? root : join(root, rel);
        // allow(silent-catch): a folder whose .gitignore cannot be read has unknown rules, and the explorer lists nothing
        // under it (walk.ts), so there is nothing it shows to watch.
        const own = await scope.descend(abs, rel).catch(() => undefined);
        if (own === undefined || closed) {
            return;
        }
        let watcher: FSWatcher;
        try {
            watcher = watch(abs, (_event, name) => {
                const path = name === null ? undefined : rel === `` ? String(name) : `${rel}/${String(name)}`;
                add(path);
                // A folder that just appeared is watched too, unless the rules say nobody opens it.
                if (path !== undefined && !own.isIgnored(String(name), path, true) && !isLockedWorkspacePath(path)) {
                    void readdir(join(root, path)).then(
                        () => watchDir(path, own),
                        // allow(silent-catch): a name that is not a readable folder (a file, gone again) has nothing to watch.
                        () => undefined,
                    );
                }
            });
        } catch {
            // allow(silent-catch): a folder that vanished or cannot be read is one there is nothing to watch in.
            return;
        }
        watcher.on(`error`, () => {
            watcher.close();
            watchers.delete(rel);
        });
        watchers.set(rel, watcher);
        // allow(silent-catch): a folder that cannot be listed is watched for itself only.
        const dirents = await readdir(abs, { withFileTypes: true }).catch(() => []);
        for (const dirent of dirents) {
            const path = rel === `` ? dirent.name : `${rel}/${dirent.name}`;
            if (dirent.isDirectory() && !own.isIgnored(dirent.name, path, true) && !isLockedWorkspacePath(path)) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- depth first on purpose: the cap then keeps whole top folders rather than a thin layer of all of them
                await watchDir(path, own);
            }
        }
    };
    void watchDir(``, createIgnoreScope(walkMatchers()));
    return {
        close: () => {
            closed = true;
            for (const watcher of watchers.values()) {
                watcher.close();
            }
            watchers.clear();
        },
    };
};

export const watchFolder = (root: string, onChange: (paths: readonly string[]) => void, log: (line: string) => void): FolderWatch => {
    const batch = batcher(onChange);
    const relative = (path: string | undefined): string | undefined => (path === undefined ? undefined : toRelPath(root, join(root, path)));
    const add = (path: string | undefined): void => batch.add(relative(path));
    if (process.platform === `win32` || process.platform === `darwin`) {
        const watcher = watchRecursively(root, add, log);
        return {
            close: () => {
                watcher?.close();
                batch.stop();
            },
        };
    }
    const folders = watchFolders(root, add, log);
    return {
        close: () => {
            folders.close();
            batch.stop();
        },
    };
};

// One watch per folder however many windows show it, closed with the last of them.
export class Watches {
    readonly #held = new Map<string, { watch: FolderWatch; listeners: Set<(paths: readonly string[]) => void> }>();

    constructor(private readonly log: (line: string) => void) {}

    subscribe(root: string, listener: (paths: readonly string[]) => void): () => void {
        let held = this.#held.get(root);
        if (held === undefined) {
            const listeners = new Set<(paths: readonly string[]) => void>();
            held = {
                listeners,
                watch: watchFolder(
                    root,
                    (paths) => {
                        for (const each of listeners) {
                            each(paths);
                        }
                    },
                    this.log,
                ),
            };
            this.#held.set(root, held);
        }
        held.listeners.add(listener);
        return () => {
            const current = this.#held.get(root);
            if (current === undefined) {
                return;
            }
            current.listeners.delete(listener);
            if (current.listeners.size === 0) {
                current.watch.close();
                this.#held.delete(root);
            }
        };
    }
}
