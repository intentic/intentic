import { stat } from "node:fs/promises";
import { defaultGit, type GitRunner, politeGit } from "@intentic/base/git";
import { commonDirOf, gitDirOf } from "../git-dir.js";
import type { NetdLink } from "../../netd/netd-link.js";

// netd counts each watched checkout's changes (_sandbox/netd, feed.rs): a generation that moves whenever anything
// a `git status` there reads may have changed, read only after every write that finished before the question was
// counted. A status read is kept per generation, so a checkout nothing touched answers from memory and spawns no git.

export interface CheckoutFeed {
    // The checkout's generation now, or undefined where nothing is counted: no netd, a directory that is not a
    // checkout, one netd has not finished watching, or one replaced at its path since it was watched. A number handed
    // out for a directory is never handed out for it again, whatever stood there.
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

// What a checkout is, as netd watches it: its own directory and its git dir, by device and inode. netd's watches hold
// an inode, not a path, so a checkout moved away or deleted and made again at the same path (an extension update's
// swap, a repository cloned again) went on being counted as the one that left, and a reading kept at its count was
// served for the one standing there now. Undefined for a directory that is no checkout.
const checkoutIdentity = async (dir: string): Promise<{ readonly gitDir: string; readonly identity: string } | undefined> => {
    const gitDir = await gitDirOf(dir);
    if (gitDir === undefined) {
        return undefined;
    }
    // allow(silent-catch): a checkout that cannot be looked at is counted as no checkout, so its reads go to git.
    const stats = await Promise.all([stat(dir), stat(gitDir)]).catch(() => undefined);
    if (stats === undefined) {
        return undefined;
    }
    const [own, admin] = stats;
    return { gitDir, identity: `${own.dev}:${own.ino} ${admin.dev}:${admin.ino}` };
};

// One watch netd was asked to keep: of what, and where its counts start. netd counts a checkout it is asked to watch
// again from zero, so each watch of a directory counts on from above every generation handed out for it before: a
// reading kept at an earlier watch's number never matches a later one.
interface Watch {
    readonly identity: string;
    readonly offset: number;
}

export const netdCheckoutFeed = (link: Pick<NetdLink, "tell" | "sync">): CheckoutFeed => {
    // The watch each directory was given, or undefined for one that is no checkout, least recently read first (Map order).
    const watched = new Map<string, Promise<Watch | undefined>>();
    // The highest generation handed out per directory across all its watches: where its next watch counts on from.
    const handed = new Map<string, number>();
    let batch: { readonly dirs: string[]; readonly answer: Promise<(number | null)[]> } | undefined;

    const release = (dir: string, held: Promise<Watch | undefined>): void => {
        // Only the watch this caller read: a newer one taken meanwhile stands.
        if (watched.get(dir) === held) {
            watched.delete(dir);
            link.tell({ kind: "unwatch", dir });
        }
    };

    const watch = (dir: string): Promise<Watch | undefined> => {
        const held = watched.get(dir);
        if (held !== undefined) {
            watched.delete(dir);
            watched.set(dir, held);
            return held;
        }
        const offset = (handed.get(dir) ?? -1) + 1;
        const resolving = (async (): Promise<Watch | undefined> => {
            const checkout = await checkoutIdentity(dir);
            if (checkout === undefined) {
                return undefined;
            }
            link.tell({ kind: "watch", checkout: { dir, gitDir: checkout.gitDir, commonDir: await commonDirOf(checkout.gitDir) } });
            return { identity: checkout.identity, offset };
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
        // The identity is read beside the sync rather than before it, so every generation asked in one turn still rides
        // one sync. A caller that finds the checkout replaced gets no count, and the next one watches what stands there.
        generation: async (dir) => {
            const held = watch(dir);
            const [counted, now] = await Promise.all([
                held.then(async (kept) => (kept === undefined ? undefined : { kept, count: await ask(dir) })),
                checkoutIdentity(dir),
            ]);
            if (counted?.kept.identity !== now?.identity) {
                release(dir, held);
                return undefined;
            }
            if (counted === undefined || counted.count === null) {
                return undefined;
            }
            const generation = counted.kept.offset + counted.count;
            handed.set(dir, Math.max(handed.get(dir) ?? -1, generation));
            return generation;
        },
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
