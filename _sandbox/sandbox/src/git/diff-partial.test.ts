import { expect, test } from "vitest";
import { additionPatch, MAX_PATCH_BYTES, partialDiff } from "./diff-partial.js";

/* The unit under test is the BARGAIN, not git: given whatever git printed, what travels to the browser, and
 * what does the response say when nothing can. The pairing itself (which rev-specs each source names) is the
 * callers' and is pinned by changes.integration.test.ts against a real repo. */

const runner =
    (stdout: string) =>
    (args: readonly string[]): Promise<string> => {
        expect(args.slice(0, 5)).toEqual(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3"]);
        return Promise.resolve(stdout);
    };

const HEADED = ["diff --git a/x b/x", "index 89715aa..db2085f 100644", "--- a/x", "+++ b/x", "@@ -4,3 +4,3 @@", " a", "-b", "+B"].join("\n");

test("ships the hunks and the sizes, and drops the file headers no one can apply", async () => {
    const { binary, partial } = await partialDiff(runner(HEADED), ["HEAD", "--", "x"], { before: 900_000, after: 910_000 });
    expect(binary).toBe(false);
    expect(partial).toEqual({ beforeBytes: 900_000, afterBytes: 910_000, patch: "@@ -4,3 +4,3 @@\n a\n-b\n+B" });
});

test("an absent side is absent from the sizes rather than a zero", async () => {
    const { partial } = await partialDiff(runner(HEADED), ["HEAD", "--", "x"], { before: undefined, after: 4_000_000 });
    expect(partial.beforeBytes).toBeUndefined();
    expect(partial.afterBytes).toBe(4_000_000);
});

/* The one thing the size cap could never learn: a 4 MB "text" file that is really a screenshot was sized and
 * never read, so git's verdict here is the first and only chance to say so, and it is what routes the file to
 * the byte viewer instead of an empty pane. */
test("git's binary verdict on a file too big to have been read is carried back", async () => {
    const { binary, partial } = await partialDiff(runner("Binary files a/x and b/x differ\n"), ["HEAD", "--", "x"], {
        before: 4_000_000,
        after: 4_100_000,
    });
    expect(binary).toBe(true);
    expect(partial.patch).toBeUndefined();
});

test("identical sides produce no patch, and no claim that there was one", async () => {
    const { binary, partial } = await partialDiff(runner(""), ["HEAD", "--", "x"], { before: 900_000, after: 900_000 });
    expect(binary).toBe(false);
    expect(partial).toEqual({ beforeBytes: 900_000, afterBytes: 900_000 });
});

test("a git that refuses degrades to the sizes rather than failing the whole diff", async () => {
    const { partial } = await partialDiff(() => Promise.reject(new Error("fatal: bad revision")), ["HEAD", "--", "x"], {
        before: 900_000,
        after: undefined,
    });
    expect(partial).toEqual({ beforeBytes: 900_000 });
});

// Cut BETWEEN regions, so what arrives is a whole number of changes: half a hunk reads as a change that isn't
// there, and there is no way for the reader to tell it from one that is.
test("past the budget the patch stops at a region boundary and says there is more", async () => {
    const region = (start: number): string => [`@@ -${start},3 +${start},3 @@`, ` ${"a".repeat(40_000)}`, `-b`, `+B`].join("\n");
    const many = [region(10), region(1_000), region(2_000), region(3_000), region(4_000), region(5_000), region(6_000), region(7_000)].join("\n");
    const { partial } = await partialDiff(runner(many), ["HEAD", "--", "x"], { before: 9_000_000, after: 9_000_000 });
    expect(partial.more).toBe(true);
    expect(Buffer.byteLength(partial.patch ?? "", "utf8")).toBeLessThanOrEqual(MAX_PATCH_BYTES);
    // Whole regions only: the last line kept is the last line of a region, never a header with nothing under it.
    expect(partial.patch?.endsWith("+B")).toBe(true);
    expect(partial.patch?.split("\n").filter((line) => line.startsWith("@@ ")).length).toBe(6);
});

/* A single region bigger than the whole budget is what an added or deleted file is: there is no earlier
 * boundary to fall back to, so it is cut at a line and the reader gets the head of the file, which is the peek
 * they came for. */
test("one region bigger than the budget is cut at a line rather than thrown away", async () => {
    const whole = ["@@ -0,0 +1,400000 @@", ...Array.from({ length: 400_000 }, (_, index) => `+line ${index}`)].join("\n");
    const { partial } = await partialDiff(runner(whole), [`4b825dc`, "HEAD", "--", "x"], { before: undefined, after: 6_000_000 });
    expect(partial.more).toBe(true);
    expect(partial.patch?.startsWith("@@ -0,0 +1,400000 @@\n+line 0\n")).toBe(true);
    expect(Buffer.byteLength(partial.patch ?? "", "utf8")).toBeLessThanOrEqual(MAX_PATCH_BYTES);
    // Every line whole: a patch cut mid-line would put half a source line in the reader's pane.
    expect(partial.patch?.split("\n").at(-1)).toMatch(/^\+line \d+$/);
});

/* The untracked case, which git answers with nothing at all: the file has no counterpart, so the patch is
 * written here instead of asked for, and it has to come out in the shape the browser's parser already reads. */
test("a file with no counterpart is written out as the additions it is", () => {
    expect(additionPatch("a\nb\nc\n", true)).toEqual({ patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c", more: false });
});

test("a file with no trailing newline is not given a phantom last line", () => {
    expect(additionPatch("a\nb", true)).toEqual({ patch: "@@ -0,0 +1,2 @@\n+a\n+b", more: false });
});

test("a head that stopped short of the file's end says there is more, even inside the budget", () => {
    expect(additionPatch("a\nb\n", false).more).toBe(true);
});

test("the + prefixes cannot carry the written patch past the budget either", () => {
    const head = `${Array.from({ length: 200_000 }, (_, index) => `line ${index}`).join("\n")}\n`;
    const { patch, more } = additionPatch(head, true);
    expect(more).toBe(true);
    expect(Buffer.byteLength(patch, "utf8")).toBeLessThanOrEqual(MAX_PATCH_BYTES);
    expect(patch.split("\n").at(-1)).toMatch(/^\+line \d+$/);
});
