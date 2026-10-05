import { TRASH_KEEP_MS, trashedAt, trashExpired } from "./trash-sweep.js";

const DAY_MS = 24 * 60 * 60_000;
const NOW = 1_791_237_277_000;

test("an entry's own times say when it was set aside when its name carries no stamp", () => {
    expect(trashedAt("notes", { mtimeMs: NOW - 30 * DAY_MS, ctimeMs: NOW - 20 * DAY_MS })).toBe(NOW - 20 * DAY_MS);
});

test("the stamp a writer put in the name counts, and only ever makes an entry younger", () => {
    // A git dir last written weeks before it was moved in: the stamp and the rename's ctime agree on the move.
    const moved = NOW - 17 * DAY_MS;
    expect(trashedAt(`extensions%2Fcontact-sheet-brisk-comet-uvyc-${String(moved)}`, { mtimeMs: moved - 9 * DAY_MS, ctimeMs: moved })).toBe(moved);
    // A stamp later than the disk's times wins; one earlier than them is outvoted.
    expect(trashedAt(`root-calm-vale-gbmd-${String(NOW - DAY_MS)}`, { mtimeMs: NOW - 30 * DAY_MS, ctimeMs: NOW - 30 * DAY_MS })).toBe(NOW - DAY_MS);
    expect(trashedAt(`root-calm-vale-gbmd-${String(NOW - 30 * DAY_MS)}`, { mtimeMs: NOW - 30 * DAY_MS, ctimeMs: NOW - DAY_MS })).toBe(NOW - DAY_MS);
});

test("a number that is not a millisecond stamp, or not at the end, is not read as one", () => {
    const times = { mtimeMs: NOW - 30 * DAY_MS, ctimeMs: NOW - 30 * DAY_MS };
    expect(trashedAt("ci-fix-intentic-35244797817", times)).toBe(NOW - 30 * DAY_MS);
    expect(trashedAt(`x-${String(NOW)}-old`, times)).toBe(NOW - 30 * DAY_MS);
});

test("an entry goes only once it has been kept past its while, and one stamped in the future stays", () => {
    expect(TRASH_KEEP_MS).toBe(14 * DAY_MS);
    expect(trashExpired(NOW - TRASH_KEEP_MS, NOW)).toBe(false);
    expect(trashExpired(NOW - TRASH_KEEP_MS - 1, NOW)).toBe(true);
    expect(trashExpired(NOW + DAY_MS, NOW)).toBe(false);
});
