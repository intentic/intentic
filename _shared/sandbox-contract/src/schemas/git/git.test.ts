import { isScratch } from "./git.js";

test("a scratch directory entry covers everything under it, and a file entry only itself", () => {
    const scratch = [{ path: ".trun/" }, { path: "src/debug.log" }];

    expect(isScratch(".trun/deep/x.log", scratch)).toBe(true);
    expect(isScratch(".trunk/x", scratch)).toBe(false);
    expect(isScratch("src/debug.log", scratch)).toBe(true);
    expect(isScratch("src/debug.log.txt", scratch)).toBe(false);
});
