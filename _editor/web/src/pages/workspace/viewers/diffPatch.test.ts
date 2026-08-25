import { expect, test } from "vitest";
import { PATCH_GAP, patchedSides } from "./diffPatch";

/* What a rebuilt side has to get right is the GUTTER: a hunk at line 4,182 has to say 4,182, because the file
 * it came from is one the reader cannot open to check. Everything else here follows from that. */

const patch = [`@@ -1,4 +1,4 @@`, ` one`, `-two`, `+TWO`, ` three`, ` four`, `@@ -120,3 +120,4 @@ context heading`, ` a`, `+b`, ` c`, ` d`].join(
    `\n`,
);

test(`rebuilds both sides and numbers every line the way the file does`, () => {
    const sides = patchedSides(patch);
    expect(sides).toBeDefined();
    // The two regions, with a marker holding them apart: they are 115 lines apart in the real file.
    expect(sides?.before.split(`\n`)).toEqual([`one`, `two`, `three`, `four`, PATCH_GAP, `a`, `c`, `d`]);
    expect(sides?.after.split(`\n`)).toEqual([`one`, `TWO`, `three`, `four`, PATCH_GAP, `a`, `b`, `c`, `d`]);
    // 0 is the marker, which came from nowhere in the file and gets no number in the gutter.
    expect(sides?.beforeLines).toEqual([1, 2, 3, 4, 0, 120, 121, 122]);
    expect(sides?.afterLines).toEqual([1, 2, 3, 4, 0, 120, 121, 122, 123]);
    expect(sides?.regions).toBe(2);
});

test(`marks the join on BOTH sides, so the diff engine reads it as an unchanged line`, () => {
    const sides = patchedSides(patch);
    expect(sides?.before.split(`\n`).indexOf(PATCH_GAP)).toBe(4);
    expect(sides?.after.split(`\n`).indexOf(PATCH_GAP)).toBe(4);
});

test(`opens with a marker when the first region is not the top of the file`, () => {
    const sides = patchedSides([`@@ -50,2 +50,2 @@`, `-x`, `+y`, ` z`].join(`\n`));
    expect(sides?.before.split(`\n`)).toEqual([PATCH_GAP, `x`, `z`]);
    expect(sides?.beforeLines).toEqual([0, 50, 51]);
});

test(`opens with no marker when the region IS the top of the file`, () => {
    const sides = patchedSides([`@@ -1,1 +1,1 @@`, `-x`, `+y`].join(`\n`));
    expect(sides?.before).toBe(`x`);
    expect(sides?.after).toBe(`y`);
});

test(`an added file has an empty before side and starts at line 1 without a marker`, () => {
    const sides = patchedSides([`@@ -0,0 +1,3 @@`, `+a`, `+b`, `+c`].join(`\n`));
    expect(sides?.before).toBe(``);
    expect(sides?.after.split(`\n`)).toEqual([`a`, `b`, `c`]);
    expect(sides?.afterLines).toEqual([1, 2, 3]);
});

test(`a patch the daemon cut short says so with a trailing marker`, () => {
    const sides = patchedSides([`@@ -1,2 +1,2 @@`, `-x`, `+y`, ` z`].join(`\n`), true);
    expect(sides?.after.split(`\n`).at(-1)).toBe(PATCH_GAP);
    expect(sides?.afterLines.at(-1)).toBe(0);
});

test(`counts the lines it RECEIVES, so a region clipped mid-hunk still numbers right`, () => {
    // The header claims 900 lines; the patch holds three, because the daemon cut it at its byte budget.
    const sides = patchedSides([`@@ -10,900 +10,900 @@`, ` a`, `-b`, `+B`].join(`\n`), true);
    expect(sides?.beforeLines).toEqual([0, 10, 11, 0]);
    expect(sides?.afterLines).toEqual([0, 10, 11, 0]);
});

test(`ignores git's file headers above the first region`, () => {
    const sides = patchedSides(
        [`diff --git a/x b/x`, `index 89715aa..db2085f 100644`, `--- a/x`, `+++ b/x`, `@@ -1,1 +1,1 @@`, `-x`, `+y`].join(`\n`),
    );
    expect(sides?.before).toBe(`x`);
    expect(sides?.regions).toBe(1);
});

test(`reads a context line whose leading space was stripped rather than stopping there`, () => {
    const sides = patchedSides([`@@ -1,3 +1,3 @@`, ` a`, ``, `-c`, `+C`].join(`\n`));
    expect(sides?.before.split(`\n`)).toEqual([`a`, ``, `c`]);
    expect(sides?.beforeLines).toEqual([1, 2, 3]);
});

test(`a patch with no regions in it is nothing to render`, () => {
    expect(patchedSides(``)).toBeUndefined();
    expect(patchedSides(`Binary files a/x and b/x differ`)).toBeUndefined();
});
