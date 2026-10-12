import { readSwaps, swapsArgs, swapsFrom, swapsUnderway } from "./ic-swaps.js";

/* Which swaps are going on is ic's answer. These hold the choice between ic and the fallback, and what the agent does with
what ic says, without a binary. */

const ROW_LIVE = { slug: "work", phase: "cutover", at: 1_000, alive: 5_000, cutoverInProgress: true };
const ROW_DEAD = { slug: "dead", phase: "cutover", at: 1_000, cutoverInProgress: false };
const ROW_PROVING = { slug: "proving", phase: "probation", at: 1_000, probationUntil: 90_000_000, cutoverInProgress: false };

// What the fallback would say if it were asked: the opposite of ic on every row, so a test sees whose answer it got.
const FILES = [{ slug: "files", phase: "cutover", at: 1_000, cutoverInProgress: true }];

test("ic is asked for the swaps as JSON, docker-free by its verb", () => {
    expect(swapsArgs).toEqual(["sandbox", "swaps", "--json"]);
});

test("ic's line is read row for row, with the verdict ic gave", () => {
    const stdout = `${JSON.stringify([ROW_LIVE, ROW_DEAD, ROW_PROVING])}\n`;
    expect(swapsFrom(stdout)).toEqual([ROW_LIVE, ROW_DEAD, ROW_PROVING]);
    expect(swapsFrom("[]\n")).toEqual([]);
});

test("a line that is not ic's answer is no answer", () => {
    expect(swapsFrom("")).toBeUndefined();
    expect(swapsFrom("error: unrecognized subcommand 'swaps'")).toBeUndefined();
    expect(swapsFrom("[not json")).toBeUndefined();
    // A row without ic's verdict is not one of its rows.
    expect(swapsFrom(JSON.stringify([{ slug: "work", phase: "cutover", at: 1 }]))).toBeUndefined();
});

test("ic's answer is the answer, and the records are not read", async () => {
    const files = jest.fn(async () => FILES);
    const swaps = await readSwaps({ ic: async () => JSON.stringify([ROW_DEAD]), files });
    expect(swaps).toEqual([ROW_DEAD]);
    expect(files).not.toHaveBeenCalled();
});

test("an ic with no swaps to report answers an empty list, which is an answer", async () => {
    const files = jest.fn(async () => FILES);
    expect(await readSwaps({ ic: async () => "[]\n", files })).toEqual([]);
    expect(files).not.toHaveBeenCalled();
});

// COMPAT(ic-swaps): an ic from before the command exits with its usage, or is not installed, or fails.
test.each([
    ["no ic could answer", undefined],
    ["an ic printed its usage for a verb it does not know", "error: unrecognized subcommand 'swaps'\n"],
    ["an ic answered with a shape this agent cannot read", JSON.stringify({ swaps: [] })],
])("when %s, the same rule is applied to the records here", async (_why, stdout) => {
    expect(await readSwaps({ ic: async () => stdout, files: async () => FILES })).toEqual(FILES);
});

test("a restart is held by the cutovers a live ic run is doing, and by nothing else", () => {
    expect(swapsUnderway([ROW_LIVE, ROW_DEAD, ROW_PROVING])).toEqual(["work"]);
    expect(swapsUnderway([])).toEqual([]);
});
