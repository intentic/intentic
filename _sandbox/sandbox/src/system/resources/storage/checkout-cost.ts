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
const folderCache = new Map<string, Promise<readonly { readonly path: string; readonly bytes: number }[]>>();

export const checkoutCost = (dir: string, sha: string, git: GitRunner = defaultGit, cone?: readonly string[]): Promise<number> => {
    const normalizedCone = cone === undefined ? undefined : [...new Set(cone)].sort();
    const key = `${dir}\0${sha}\0${normalizedCone === undefined ? "*" : normalizedCone.join("\0")}`;
    const held = cache.get(key);
    if (held !== undefined) {
        // Read again, so the entries asked for most recently are the last to go.
        cache.delete(key);
        cache.set(key, held);
        return held;
    }
    const reading = (async (): Promise<number> => {
        if (normalizedCone === undefined) {
            return blobBytes((await git(dir, [...LS_TREE_ARGS, sha])).stdout);
        }
        const root = blobBytes((await git(dir, ["ls-tree", "--full-tree", "--format=%(objecttype) %(objectsize)", sha])).stdout);
        if (normalizedCone.length === 0) {
            return root;
        }
        const scoped = blobBytes((await git(dir, [...LS_TREE_ARGS, sha, "--", ...normalizedCone])).stdout);
        return root + scoped;
    })();
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

const treeEntries = async (dir: string, tree: string, git: GitRunner): Promise<readonly { readonly type: string; readonly oid: string; readonly name: string }[]> => {
    const { stdout } = await git(dir, ["ls-tree", "-z", tree]);
    return stdout.split("\0").filter(Boolean).flatMap((row) => {
        const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(row);
        return match === null ? [] : [{ type: match[2] ?? "", oid: match[3] ?? "", name: match[4] ?? "" }];
    });
};

const pathBytes = async (dir: string, sha: string, path: string, git: GitRunner): Promise<number> =>
    blobBytes((await git(dir, [...LS_TREE_ARGS, sha, "--", path])).stdout);

/** Largest top-level folders, plus their immediate children under the largest one; tree listings are shallow. */
export const largestCheckoutFolders = (dir: string, sha: string, git: GitRunner = defaultGit): Promise<readonly { readonly path: string; readonly bytes: number }[]> => {
    const key = `${dir}\0${sha}`;
    const held = folderCache.get(key);
    if (held !== undefined) {
        folderCache.delete(key);
        folderCache.set(key, held);
        return held;
    }
    const reading = (async () => {
        const roots = (await treeEntries(dir, sha, git)).filter(({ type }) => type === "tree");
        const top = await Promise.all(roots.map(async ({ name }) => ({ path: name, bytes: await pathBytes(dir, sha, name, git) })));
        const largest = [...top].sort((left, right) => right.bytes - left.bytes)[0];
        const deeper = largest === undefined ? [] : await Promise.all(
            (await treeEntries(dir, `${sha}:${largest.path}`, git)).filter(({ type }) => type === "tree").map(async ({ name }) => {
                const path = `${largest.path}/${name}`;
                return { path, bytes: await pathBytes(dir, sha, path, git) };
            }),
        );
        const alternatives = top.filter(({ path }) => path !== largest?.path);
        return [...deeper, ...alternatives, ...(deeper.length === 0 && largest !== undefined ? [largest] : [])]
            .sort((left, right) => right.bytes - left.bytes)
            .slice(0, 3);
    })();
    reading.catch(() => {
        if (folderCache.get(key) === reading) {
            folderCache.delete(key);
        }
    });
    folderCache.set(key, reading);
    while (folderCache.size > CACHE_LIMIT) {
        const oldest = folderCache.keys().next().value;
        if (oldest === undefined) {break;}
        folderCache.delete(oldest);
    }
    return reading;
};
