// Discards running in the shared checkout, the daemon's own account of them (2026-11-21). A discard first takes a
// restore point, which queues behind any snapshot already hashing; once, behind one hashing 4,992 build files, a press
// showed nothing for three minutes, the owner reloaded, saw the files still there and pressed again, and the second
// discard queued behind the first. So the Changes answer says which repositories are discarding (`discarding`), the way
// it says `committing`, and a second press on the same target joins the discard already running.

export interface DiscardRuns {
    // Repositories with a discard running now, for the Changes answer; empty when none is.
    readonly repos: () => string[];
    // Runs `task` as the discard of `target` in `repo`, or answers the one already running for exactly that.
    readonly run: (repo: string, target: string, task: () => Promise<void>) => Promise<void>;
}

export const createDiscardRuns = (): DiscardRuns => {
    const running = new Map<string, Promise<void>>();
    const perRepo = new Map<string, number>();
    const release = (repo: string, key: string): void => {
        running.delete(key);
        const left = (perRepo.get(repo) ?? 1) - 1;
        if (left === 0) {
            perRepo.delete(repo);
        } else {
            perRepo.set(repo, left);
        }
    };
    return {
        repos: () => [...perRepo.keys()],
        run: (repo, target, task) => {
            const key = `${repo}\0${target}`;
            const joined = running.get(key);
            if (joined !== undefined) {
                return joined;
            }
            perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
            const started = task().finally(() => release(repo, key));
            running.set(key, started);
            return started;
        },
    };
};
