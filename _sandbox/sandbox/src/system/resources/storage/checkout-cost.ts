import { defaultGit, type GitRunner } from "@intentic/base/git";

// NUL records keep a filename containing a newline from looking like another blob. Gitlinks have no blob size.
export const blobBytes = (tree: string): number =>
    tree.split("\0").reduce((total, record) => {
        const size = /^\d+ blob [0-9a-f]+\s+(\d+)\t/.exec(record)?.[1];
        return total + (size === undefined ? 0 : Number(size));
    }, 0);

// Share the in-flight read too: opening Storage beside a first turn must not walk the same tree twice.
const runners = new WeakMap<GitRunner, Map<string, Promise<number>>>();
export const checkoutCost = (dir: string, sha: string, git: GitRunner = defaultGit): Promise<number> => {
    let cache = runners.get(git);
    if (cache === undefined) {
        cache = new Map();
        runners.set(git, cache);
    }
    const key = `${dir}\0${sha}`;
    let pending = cache.get(key);
    if (pending === undefined) {
        const reading = git(dir, ["ls-tree", "-r", "-l", "-z", "--full-tree", sha]).then(({ stdout }) => blobBytes(stdout));
        // A read that failed (a repo mid-clone, a lock) is not an answer to keep: the next ask reads again.
        reading.catch(() => cache.delete(key));
        pending = reading;
        cache.set(key, pending);
    }
    return pending;
};
