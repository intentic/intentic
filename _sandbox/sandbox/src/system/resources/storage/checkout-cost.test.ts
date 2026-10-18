import type { GitRunner } from "@intentic/base/git";
import { blobBytes, checkoutCost } from "./checkout-cost.js";

const tree = "100644 blob abc123 17\ta\0" + "120000 blob def456 4\tlink\nname\0" + "160000 commit abcdef -\tsubmodule\0";

test("checkout cost counts every blob path, including links, and skips gitlinks", () => {
    expect(blobBytes(`${tree  }100644 blob abc123 17\tsecond-copy\0`)).toBe(38);
    expect(blobBytes("")).toBe(0);
});

test("concurrent and repeated reads share one tree walk per repository and sha", async () => {
    const calls: unknown[] = [];
    const git: GitRunner = async (dir, args) => {
        calls.push([dir, args]);
        return { stdout: tree, stderr: "" };
    };
    expect(await Promise.all([checkoutCost("/repo", "a", git), checkoutCost("/repo", "a", git)])).toEqual([21, 21]);
    expect(await checkoutCost("/repo", "a", git)).toBe(21);
    expect(calls).toEqual([["/repo", ["ls-tree", "-r", "-l", "-z", "--full-tree", "a"]]]);
    expect(await checkoutCost("/repo", "b", git)).toBe(21);
    expect(await checkoutCost("/other", "a", git)).toBe(21);
    expect(calls.length).toBe(3);
});
