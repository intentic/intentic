import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FromNode } from "@intentic/sandbox-contract/netd-wire";
import { defaultGit, type GitRunner, observeGitCommands } from "@intentic/base/git";
import { statusPaths } from "../changes/changes.js";
import { gitSlice } from "../git-slice.js";
import { type CheckoutFeed, MAX_WATCHED, netdCheckoutFeed, readOnFeed, useCheckoutFeed } from "./checkout-feed.js";

// The daemon's half of the change feed against a stand-in netd: which checkouts it names, how its questions batch,
// and that a status read is taken once per generation and never handed out to be changed under the next reader.

const exec = promisify(execFile);

const tempDirs: string[] = [];
afterEach(async () => {
    useCheckoutFeed(undefined);
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-feed-"));
    tempDirs.push(dir);
    return dir;
};

// A directory that reads as a checkout (its own `.git` dir), without a repository behind it.
const checkoutIn = async (parent: string, name: string): Promise<string> => {
    const dir = join(parent, name);
    await mkdir(join(dir, ".git"), { recursive: true });
    return dir;
};

// Each checkout is named only once its own `.git` has been read off the disk, so two checkouts watched together are
// named in whichever order the filesystem answers — the arrival order of two round trips, not a contract. Messages
// about distinct directories are read in a settled order instead; the kinds and the count stay asserted as they are.
const dirOf = (message: FromNode): string => {
    if (message.kind === "watch") {
        return message.checkout.dir;
    }
    return message.kind === "unwatch" ? message.dir : "";
};
const byDir = (told: readonly FromNode[]): FromNode[] =>
    told.toSorted((one, two) => Number(dirOf(one) > dirOf(two)) - Number(dirOf(one) < dirOf(two)));

// netd's end of the socket: what it was told, the syncs it was asked, answered from `counts`.
const standIn = (counts: Map<string, number>) => {
    const told: FromNode[] = [];
    const asked: string[][] = [];
    return {
        told,
        asked,
        link: {
            tell: (message: FromNode) => told.push(message),
            sync: async (dirs: readonly string[]) => {
                asked.push([...dirs]);
                return dirs.map((dir) => counts.get(dir) ?? null);
            },
        },
    };
};

test("names each checkout once, and once they are watched asks one sync for every checkout read together", async () => {
    const parent = await tempDir();
    const [a, b] = await Promise.all([checkoutIn(parent, "a"), checkoutIn(parent, "b")]);
    const netd = standIn(new Map([[a, 4]]));
    const feed = netdCheckoutFeed(netd.link);

    expect(await Promise.all([feed.generation(a), feed.generation(b)])).toEqual([4, undefined]);
    expect(byDir(netd.told)).toEqual([
        { kind: "watch", checkout: { dir: a, gitDir: join(a, ".git"), commonDir: join(a, ".git") } },
        { kind: "watch", checkout: { dir: b, gitDir: join(b, ".git"), commonDir: join(b, ".git") } },
    ]);
    netd.asked.length = 0;
    expect(await Promise.all([feed.generation(a), feed.generation(b), feed.generation(a)])).toEqual([4, undefined, 4]);
    expect(netd.asked).toEqual([[a, b, a]]);
    expect(netd.told).toHaveLength(2);
});

test("a directory that is no checkout is never named and never asked about", async () => {
    const plain = await tempDir();
    const netd = standIn(new Map());
    const feed = netdCheckoutFeed(netd.link);
    expect(await feed.generation(plain)).toBeUndefined();
    expect(netd.told).toEqual([]);
    expect(netd.asked).toEqual([]);
});

test("lets the least recently read checkout go once more are watched than the kernel should hold", async () => {
    const parent = await tempDir();
    const dirs = await Promise.all(Array.from({ length: MAX_WATCHED + 1 }, (_, index) => checkoutIn(parent, `c${String(index)}`)));
    const netd = standIn(new Map());
    const feed = netdCheckoutFeed(netd.link);
    for (const dir of dirs) {
        await feed.generation(dir);
    }
    const [oldest] = dirs;
    expect(netd.told.filter((message) => message.kind === "unwatch")).toEqual([{ kind: "unwatch", dir: oldest ?? "" }]);
});

// netd's watches hold an inode: a checkout swapped out at its path (an extension update, a repository cloned again) is
// not the one netd goes on counting, and netd counts a checkout watched again from zero.
test("a checkout replaced at its path is watched afresh, and no generation handed out for the path repeats", async () => {
    const parent = await tempDir();
    const dir = await checkoutIn(parent, "ext");
    const counts = new Map([[dir, 3]]);
    const netd = standIn(counts);
    const feed = netdCheckoutFeed(netd.link);
    const first = await feed.generation(dir);
    expect(first).toBe(3);

    await rename(dir, join(parent, "ext.previous"));
    await mkdir(join(dir, ".git"), { recursive: true });
    // The caller that finds the swap gets no count; the watch it read is let go.
    expect(await feed.generation(dir)).toBeUndefined();
    expect(netd.told.filter((message) => message.kind === "unwatch")).toEqual([{ kind: "unwatch", dir }]);
    // netd counts the new watch from scratch; what the feed hands out still climbs past everything said before.
    counts.set(dir, 1);
    const again = await feed.generation(dir);
    expect(netd.told.filter((message) => message.kind === "watch")).toHaveLength(2);
    expect(again).toBeGreaterThan(first ?? Number.POSITIVE_INFINITY);
});

test("a checkout let go for room and watched again never repeats a generation it was read at", async () => {
    const parent = await tempDir();
    const dirs = await Promise.all(Array.from({ length: MAX_WATCHED + 1 }, (_, index) => checkoutIn(parent, `c${String(index)}`)));
    const [oldest] = dirs;
    const counts = new Map(dirs.map((dir) => [dir, 2]));
    const feed = netdCheckoutFeed(standIn(counts).link);
    const before = await feed.generation(oldest ?? "");
    for (const dir of dirs.slice(1)) {
        await feed.generation(dir);
    }
    // Let go past the ceiling, then read again: netd's count for it starts over and lands on the same number.
    expect(await feed.generation(oldest ?? "")).not.toBe(before);
});

test("a reading kept for a checkout is not served for the one that replaced it, though netd's count lands on the same number", async () => {
    const parent = await tempDir();
    const dir = await checkoutIn(parent, "repo");
    const counts = new Map([[dir, 5]]);
    useCheckoutFeed(netdCheckoutFeed(standIn(counts).link));
    let reads = 0;
    const read = async () => {
        reads += 1;
        return reads;
    };
    expect(await readOnFeed("kind", dir, defaultGit, read)).toBe(1);
    expect(await readOnFeed("kind", dir, defaultGit, read)).toBe(1);
    await rename(dir, join(parent, "repo.gone"));
    await mkdir(join(dir, ".git"), { recursive: true });
    expect(await readOnFeed("kind", dir, defaultGit, read)).toBe(2);
    // Watched afresh, at netd's same count as the first watch: still a new reading, then held at it.
    expect(await readOnFeed("kind", dir, defaultGit, read)).toBe(3);
    expect(await readOnFeed("kind", dir, defaultGit, read)).toBe(3);
});

// An extension update or revert swaps checkouts by renaming them, so the install's path holds another checkout whose
// HEAD netd never watched: the slice's HEAD read, kept per generation, must not answer with the one that left.
test("an installed checkout's HEAD is read once while its count stands, and afresh for the checkout swapped in", async () => {
    const parent = await tempDir();
    const repoAt = async (name: string, content: string): Promise<{ dir: string; head: string }> => {
        const dir = join(parent, name);
        await mkdir(dir, { recursive: true });
        await exec("git", ["-C", dir, "init", "-q"]);
        await writeFile(join(dir, "a.txt"), content);
        await exec("git", ["-C", dir, "add", "-A"]);
        await exec("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", content]);
        return { dir, head: (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim() };
    };
    const live = await repoAt("ext", "one\n");
    const staged = await repoAt("ext.staging", "two\n");
    useCheckoutFeed(netdCheckoutFeed(standIn(new Map([[live.dir, 4]])).link));
    // SAFETY: the git slice reads nothing of the core it is handed; every verb is a plain subprocess function.
    const { git } = gitSlice.build({} as never);
    const runs: string[] = [];
    observeGitCommands(({ dir: at }) => {
        if (at === live.dir) {
            runs.push(at);
        }
    });
    expect(await git.fullHead(live.dir)).toBe(live.head);
    expect(await git.fullHead(live.dir)).toBe(live.head);
    expect(runs).toHaveLength(1);

    await rename(live.dir, join(parent, "ext.previous"));
    await rename(staged.dir, live.dir);
    expect(await git.fullHead(live.dir)).toBe(staged.head);
});

// A feed standing still at one generation per directory, until the test moves it.
const stillFeed = (generations: Map<string, number>): CheckoutFeed => ({ generation: async (dir) => generations.get(dir) });

test("reads once per generation, again when it moves, and hands every reader a copy of its own", async () => {
    const generations = new Map([["/repo", 1]]);
    useCheckoutFeed(stillFeed(generations));
    let reads = 0;
    const read = async () => {
        reads += 1;
        return { paths: ["a.ts"] };
    };
    const first = await readOnFeed("kind", "/repo", defaultGit, read);
    first.paths.push("changed under the reader");
    expect(await readOnFeed("kind", "/repo", defaultGit, read)).toEqual({ paths: ["a.ts"] });
    expect(reads).toBe(1);
    generations.set("/repo", 2);
    await readOnFeed("kind", "/repo", defaultGit, read);
    expect(reads).toBe(2);
});

test("a runner of the caller's own, a failed read and a checkout nothing counts are always read afresh", async () => {
    useCheckoutFeed(stillFeed(new Map([["/repo", 1]])));
    let reads = 0;
    const read = async () => {
        reads += 1;
        return reads;
    };
    const own: GitRunner = async () => ({ stdout: "", stderr: "" });
    await readOnFeed("kind", "/repo", own, read);
    await readOnFeed("kind", "/repo", own, read);
    expect(reads).toBe(2);

    await expect(
        readOnFeed("fails", "/repo", defaultGit, async () => {
            throw new Error("no");
        }),
    ).rejects.toThrow("no");
    expect(await readOnFeed("fails", "/repo", defaultGit, async () => "read")).toBe("read");

    await readOnFeed("kind", "/elsewhere", defaultGit, read);
    await readOnFeed("kind", "/elsewhere", defaultGit, read);
    expect(reads).toBe(4);
});

test("an agent's status around a command spawns no git while the checkout's count stands still", async () => {
    const dir = await tempDir();
    await exec("git", ["-C", dir, "init", "-q"]);
    await writeFile(join(dir, "a.txt"), "a\n");
    const generations = new Map([[dir, 7]]);
    useCheckoutFeed(stillFeed(generations));
    const runs: string[] = [];
    observeGitCommands(({ dir: at }) => {
        if (at === dir) {
            runs.push(at);
        }
    });
    expect(await statusPaths(dir)).toEqual(["a.txt"]);
    expect(await statusPaths(dir)).toEqual(["a.txt"]);
    expect(runs).toHaveLength(1);
    await writeFile(join(dir, "b.txt"), "b\n");
    generations.set(dir, 8);
    expect((await statusPaths(dir)).toSorted()).toEqual(["a.txt", "b.txt"]);
    expect(runs).toHaveLength(2);
});
