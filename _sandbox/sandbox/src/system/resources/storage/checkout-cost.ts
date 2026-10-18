import { defaultGit, type GitRunner } from "@intentic/base/git";

// WHAT ONE FULL CHECKOUT OF A COMMIT COSTS: the sum of its blobs' sizes. Asked as type and size only, never the paths
// (2026-10-18): the runner keeps at most 16 MiB of a command's output (base/git MAX_GIT_OUTPUT), and `ls-tree -r -l`
// prints every path, which past ~150k files ran over it and read as "size unknown" for exactly the big repositories this
// estimate exists for. A record here is a dozen bytes, so the same cap holds over a million entries. No path is printed,
// so a newline can only end a record. Gitlinks (`commit -`) and trees have no blob size and count as nothing.
const LS_TREE_ARGS = ["ls-tree", "-r", "--full-tree", "--format=%(objecttype) %(objectsize)"] as const;

export const blobBytes = (listing: string): number =>
    listing.split("\n").reduce((total, record) => {
        const size = /^blob (\d+)$/.exec(record)?.[1];
        return total + (size === undefined ? 0 : Number(size));
    }, 0);

// One answer per repository and commit, whichever runner asks: the turn sizing a first checkout and the Storage card
// reading beside it share the walk, in flight or done. Bounded, oldest first out, since every landed commit is a new
// HEAD and the daemon lives for weeks.
const CACHE_LIMIT = 256;
const cache = new Map<string, Promise<number>>();

export const checkoutCost = (dir: string, sha: string, git: GitRunner = defaultGit): Promise<number> => {
    const key = `${dir}\0${sha}`;
    const held = cache.get(key);
    if (held !== undefined) {
        // Read again, so the entries asked for most recently are the last to go.
        cache.delete(key);
        cache.set(key, held);
        return held;
    }
    const reading = git(dir, [...LS_TREE_ARGS, sha]).then(({ stdout }) => blobBytes(stdout));
    // A read that failed (a repo mid-clone, a lock) is not an answer to keep: the next ask reads again.
    reading.catch(() => {
        if (cache.get(key) === reading) {
            cache.delete(key);
        }
    });
    cache.set(key, reading);
    while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        cache.delete(oldest);
    }
    return reading;
};
