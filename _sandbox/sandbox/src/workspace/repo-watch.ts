import type { Logger } from "pino";
import { discoverRepos } from "./repo-discovery.js";
import { subscribeWorkspaceChanges } from "./workspace-watch.js";

// Repo-set change push. The file watcher descent-ignores .git (workspace-watch.ts), so the browser can never
// see a .git path, and with repos allowed anywhere under /work, no path pattern can tell "a repo appeared"
// from an ordinary dir write. The daemon detects it instead: every workspace-change batch schedules a
// throttled re-discovery, and a changed repo set is pushed to the /events stream as a reposChanged frame.

// Discovery is a filesystem walk, cap it to one scan per window even while the agent writes continuously.
const RESCAN_THROTTLE_MS = 2_000;

export interface RepoWatch {
    subscribe(listener: (repos: string[]) => void): () => void;
}

const createRepoWatch = (
    root: string,
    changes: (listener: (paths: string[]) => void) => () => void,
    logger?: Logger,
): RepoWatch & { close: () => void } => {
    const listeners = new Set<(repos: string[]) => void>();
    let known: string[] | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastScan = 0;

    const rescan = async (): Promise<void> => {
        const repos = await discoverRepos(root);
        if (known !== undefined && repos.length === known.length && repos.every((repo, index) => repo === known?.[index])) {
            return;
        }
        known = repos;
        for (const listener of listeners) {
            listener(repos);
        }
    };

    // Leading when idle, trailing while busy: the first change after a quiet spell rescans immediately, a
    // burst coalesces into one scan at the window's edge.
    const schedule = (): void => {
        if (timer !== undefined) {
            return;
        }
        timer = setTimeout(
            () => {
                timer = undefined;
                lastScan = Date.now();
                void rescan().catch((error: unknown) => logger?.warn({ err: error }, "repo rescan failed"));
            },
            Math.max(0, RESCAN_THROTTLE_MS - (Date.now() - lastScan)),
        );
        timer.unref();
    };

    // Baseline scan so the first change compares against reality, not undefined (which would always notify).
    void rescan().catch((error: unknown) => logger?.warn({ err: error }, "repo scan failed"));
    const unsubscribe = changes(() => schedule());

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close: () => {
            unsubscribe();
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
    };
};

// Boot-time singleton the /events handler subscribes to, mirroring workspace-watch's pattern.
let instance: RepoWatch | undefined;
export const startRepoWatch = (root: string, logger: Logger): void => {
    instance ??= createRepoWatch(root, subscribeWorkspaceChanges, logger);
};
export const subscribeRepoChanges = (listener: (repos: string[]) => void): (() => void) => instance?.subscribe(listener) ?? (() => undefined);
