import type { GitRunner } from "@intentic/base/git";
import { blobBytes, checkoutCost } from "./checkout-cost.js";

// What `ls-tree -r --format='%(objecttype) %(objectsize)'` prints: a file, a symlink (a blob too) and a gitlink, which
// has no blob size.
const listing = "blob 17\nblob 4\ncommit -\n";

test("checkout cost counts every blob, links included, and skips gitlinks", () => {
    expect(blobBytes(`${listing}blob 17\n`)).toBe(38);
    expect(blobBytes("")).toBe(0);
});

test("a tree far past the old path-listing cap is still measured", () => {
    // 300k entries: the path listing this replaced ran past the runner's 16 MiB output cap well before that.
    const big = "blob 1000\n".repeat(300_000);
    expect(big.length).toBe(3_000_000);
    expect(blobBytes(big)).toBe(300_000_000);
});

test("concurrent and repeated reads share one tree walk per repository and sha, whichever runner asks", async () => {
    const calls: unknown[] = [];
    const runner =
        (name: string): GitRunner =>
        async (dir, args) => {
            calls.push([name, dir, args]);
            return { stdout: listing, stderr: "" };
        };
    const turn = runner("turn");
    const storage = runner("storage");
    expect(await Promise.all([checkoutCost("/repo", "a", turn), checkoutCost("/repo", "a", storage)])).toEqual([21, 21]);
    expect(await checkoutCost("/repo", "a", storage)).toBe(21);
    expect(calls).toEqual([["turn", "/repo", ["ls-tree", "-r", "--full-tree", "--format=%(objecttype) %(objectsize)", "a"]]]);
    expect(await checkoutCost("/repo", "b", turn)).toBe(21);
    expect(await checkoutCost("/other", "a", turn)).toBe(21);
    expect(calls.length).toBe(3);
});

test("a failed read is not kept, and the cache holds a bounded number of commits", async () => {
    let fail = true;
    let reads = 0;
    const git: GitRunner = async () => {
        reads += 1;
        if (fail) {
            throw new Error("index.lock");
        }
        return { stdout: listing, stderr: "" };
    };
    await expect(checkoutCost("/failing", "a", git)).rejects.toThrow("index.lock");
    fail = false;
    expect(await checkoutCost("/failing", "a", git)).toBe(21);
    expect(reads).toBe(2);

    // Past the bound, the oldest commit is read again; the newest stays.
    for (let index = 0; index < 300; index += 1) {
        await checkoutCost("/bounded", `sha-${index}`, git);
    }
    const before = reads;
    await checkoutCost("/bounded", "sha-299", git);
    expect(reads).toBe(before);
    await checkoutCost("/bounded", "sha-0", git);
    expect(reads).toBe(before + 1);
});
