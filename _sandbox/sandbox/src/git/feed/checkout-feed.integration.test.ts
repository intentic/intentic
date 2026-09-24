import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FromNode } from "@intentic/sandbox-contract/front-wire";
import { defaultGit, type GitRunner, observeGitCommands } from "@intentic/scaffold";
import { statusPaths } from "../changes/changes.js";
import { type CheckoutFeed, frontCheckoutFeed, readOnFeed, useCheckoutFeed } from "./checkout-feed.js";

// The daemon's half of the change feed against a stand-in front: which checkouts it names, how its questions batch,
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

// The front's end of the lane: what it was told, the syncs it was asked, answered from `counts`.
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
    const front = standIn(new Map([[a, 4]]));
    const feed = frontCheckoutFeed(front.link);

    expect(await Promise.all([feed.generation(a), feed.generation(b)])).toEqual([4, undefined]);
    expect(front.told).toEqual([
        { kind: "watch", checkout: { dir: a, gitDir: join(a, ".git"), commonDir: join(a, ".git") } },
        { kind: "watch", checkout: { dir: b, gitDir: join(b, ".git"), commonDir: join(b, ".git") } },
    ]);
    front.asked.length = 0;
    expect(await Promise.all([feed.generation(a), feed.generation(b), feed.generation(a)])).toEqual([4, undefined, 4]);
    expect(front.asked).toEqual([[a, b, a]]);
    expect(front.told).toHaveLength(2);
});

test("a directory that is no checkout is never named and never asked about", async () => {
    const plain = await tempDir();
    const front = standIn(new Map());
    const feed = frontCheckoutFeed(front.link);
    expect(await feed.generation(plain)).toBeUndefined();
    expect(front.told).toEqual([]);
    expect(front.asked).toEqual([]);
});

test("lets the least recently read checkout go once more are watched than the kernel should hold", async () => {
    const parent = await tempDir();
    const dirs = await Promise.all(Array.from({ length: 49 }, (_, index) => checkoutIn(parent, `c${String(index)}`)));
    const front = standIn(new Map());
    const feed = frontCheckoutFeed(front.link);
    for (const dir of dirs) {
        await feed.generation(dir);
    }
    const [oldest] = dirs;
    expect(front.told.filter((message) => message.kind === "unwatch")).toEqual([{ kind: "unwatch", dir: oldest ?? "" }]);
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

    await expect(readOnFeed("fails", "/repo", defaultGit, async () => { throw new Error("no"); })).rejects.toThrow("no");
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
