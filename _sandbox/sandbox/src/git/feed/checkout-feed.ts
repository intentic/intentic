import { defaultGit, type GitRunner, politeGit } from "@intentic/base/git";
import { commonDirOf, gitDirOf } from "../git-dir.js";
import type { NetdLink } from "../../netd/netd-link.js";

// netd counts each watched checkout's changes (_sandbox/netd, feed.rs): a generation that moves whenever anything
// a `git status` there reads may have changed, read only after every write that finished before the question was
// counted. A status read is kept per generation, so a checkout nothing touched answers from memory and spawns no git.

export interface CheckoutFeed {
    // The checkout's generation now, or undefined where nothing is counted: no netd, a directory that is not a
    // checkout, or one netd has not finished watching.
    readonly generation: (dir: string) => Promise<number | undefined>;
}

// Checkouts watched at once: the workspace's repositories and the conversations working now; the least recently
// read is let go past it, each watch pinning a checkout's directories in the kernel. Sized from what one busy evening
// asks for (2026-10-08): seven conversations of eleven checkouts each, the workspace's own eleven and four installed
// extensions came to 92, and at the old 48 every read evicted another, so nearly every status went to git (49
// checkouts in 15 s, some read six times) while netd re-walked trees it had just let go. A checkout here averaged
// about 300 directory watches, so this ceiling holds under 50k of the kernel's 524k per-user default.
export const MAX_WATCHED = 160;

// A kept reading older than this is taken again whatever the count says: the bound on how long a change the feed
// could not see (a filesystem inotify is blind to) stays unread.
const MAX_AGE_MS = 60_000;

export const netdCheckoutFeed = (link: Pick<NetdLink, "tell" | "sync">): CheckoutFeed => {
    // Whether each directory is a checkout netd was asked to watch, least recently read first (Map order).
    const watched = new Map<string, Promise<boolean>>();
    let batch: { readonly dirs: string[]; readonly answer: Promise<(number | null)[]> } | undefined;

    const watch = (dir: string): Promise<boolean> => {
        const held = watched.get(dir);
        if (held !== undefined) {
            watched.delete(dir);
            watched.set(dir, held);
            return held;
        }
        const resolving = (async () => {
            const gitDir = await gitDirOf(dir);
            if (gitDir === undefined) {
                return false;
            }
            link.tell({ kind: "watch", checkout: { dir, gitDir, commonDir: await commonDirOf(gitDir) } });
            return true;
        })();
        watched.set(dir, resolving);
        for (const [oldest] of watched) {
            if (watched.size <= MAX_WATCHED) {
                break;
            }
            watched.delete(oldest);
            link.tell({ kind: "unwatch", dir: oldest });
        }
        return resolving;
    };

    // Every generation asked within one turn of the loop rides one sync.
    const ask = (dir: string): Promise<number | null> => {
        if (batch === undefined) {
            const dirs: string[] = [];
            const answer = new Promise<(number | null)[]>((resolve) =>
                queueMicrotask(() => {
                    batch = undefined;
                    void link.sync(dirs).then(resolve);
                }),
            );
            batch = { dirs, answer };
        }
        const { dirs, answer } = batch;
        const at = dirs.push(dir) - 1;
        return answer.then((generations) => generations[at] ?? null);
    };

    return {
        generation: async (dir) => ((await watch(dir)) ? ((await ask(dir)) ?? undefined) : undefined),
    };
};

interface Reading {
    readonly generation: number;
    readonly at: number;
    readonly value: Promise<unknown>;
}

const readings = new Map<string, Reading>();
let feed: CheckoutFeed | undefined;

// The daemon behind netd names its feed at boot; without one (a test, a tool) every read goes to git.
export const useCheckoutFeed = (next: CheckoutFeed | undefined): void => {
    feed = next;
    readings.clear();
};

// The generation of the checkout at `dir`, or undefined where nothing counts it.
export const checkoutGeneration = async (dir: string): Promise<number | undefined> => feed?.generation(dir);

// Reads `read` once per generation of `dir`'s checkout, for `kind` of reading; readers asking at one generation share
// it. Only the daemon's own runners are kept: a caller with a runner of its own (a test double, a private index) reads
// afresh.
export const readOnFeed = async <T>(kind: string, dir: string, git: GitRunner, read: () => Promise<T>): Promise<T> => {
    const generation = feed === undefined || (git !== defaultGit && git !== politeGit) ? undefined : await feed.generation(dir);
    if (generation === undefined) {
        return read();
    }
    const key = `${kind}\u0000${dir}`;
    const held = readings.get(key);
    if (held !== undefined && held.generation === generation && Date.now() - held.at < MAX_AGE_MS) {
        return structuredClone((await held.value) as T);
    }
    const value = read();
    readings.set(key, { generation, at: Date.now(), value });
    // A failed reading is not kept: the next asker reads again.
    value.catch(() => {
        if (readings.get(key)?.value === value) {
            readings.delete(key);
        }
    });
    return structuredClone(await value);
};
