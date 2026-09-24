import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { type HeldSlot, oldestPerSlot, slotFromFdTarget, summarisePools } from "./queue-slots.js";

/* The pure half: reading a slot out of a descriptor's target, and folding a pipeline's shared descriptors into one
   row per slot. The live half (a real flock, a real fd 9) is queue-slots.integration.test.ts. */

const ROOT = "/tmp/intentic-queue";

test("a descriptor pointing at a slot names its pool and slot", () => {
    expect(slotFromFdTarget(ROOT, `${ROOT}/heavy/slot.1`)).toEqual({ pool: "heavy", slot: "slot.1" });
    expect(slotFromFdTarget(ROOT, `${ROOT}/other-pool/slot.12`)).toEqual({ pool: "other-pool", slot: "slot.12" });
});

test.each([
    ["a descriptor on something else entirely", `${WORKSPACE_ROOT}/intentic/package.json`],
    ["a sibling directory sharing the root's characters", "/tmp/intentic-queue-scratch/heavy/slot.1"],
    ["the root itself", "/tmp/intentic-queue"],
    ["a file directly in the root, with no pool", "/tmp/intentic-queue/slot.1"],
    ["something deeper than pool and slot", "/tmp/intentic-queue/heavy/nested/slot.1"],
    ["a file in a pool that is not a slot", "/tmp/intentic-queue/heavy/notes.txt"],
    ["slot.N with a non-numeric N", "/tmp/intentic-queue/heavy/slot.x"],
])("%s is not a held slot", (_name, target) => {
    expect(slotFromFdTarget(ROOT, target)).toBeUndefined();
});

// procfs marks a descriptor whose file has been replaced. The lock on it guards an inode nothing can reach any
// more, so counting it reports a slot as taken that no command is in.
test("a deleted slot file is not a held slot", () => {
    expect(slotFromFdTarget(ROOT, `${ROOT}/heavy/slot.1 (deleted)`)).toBeUndefined();
});

const holder = (pool: string, slot: string, pid: number, holderAgeSeconds: number): HeldSlot => ({
    pool,
    slot,
    pid,
    holderAgeSeconds,
    command: `bash -c pnpm test ${pid}`,
    cwd: `${WORKSPACE_ROOT}/intentic`,
});

// The incident's shape: `npx … | tail` put fd 9 in the shell, the writer and the reader, three pids on one slot.
test("a pipeline's shared descriptors fold into one row, keeping the process that took the slot", () => {
    const folded = oldestPerSlot([holder("heavy", "slot.1", 100, 12), holder("heavy", "slot.1", 101, 1_560), holder("heavy", "slot.1", 102, 11)]);
    expect(folded).toEqual([holder("heavy", "slot.1", 101, 1_560)]);
});

test("different slots and different pools stay separate rows", () => {
    const folded = oldestPerSlot([holder("heavy", "slot.1", 1, 5), holder("heavy", "slot.2", 2, 5), holder("quiet", "slot.1", 3, 5)]);
    expect(folded).toHaveLength(3);
});

test("a pool reports its oldest holder, which is the number a stuck command shows up in", () => {
    const counts = new Map([
        ["heavy", 2],
        ["quiet", 1],
    ]);
    const summary = summarisePools(counts, [holder("heavy", "slot.1", 1, 30), holder("heavy", "slot.2", 2, 1_800)]);
    expect(summary["heavy"]).toEqual({
        slots: 2,
        held: 2,
        longestHoldSeconds: 1_800,
        longestHolder: { pid: 2, command: "bash -c pnpm test 2", cwd: `${WORKSPACE_ROOT}/intentic` },
    });
    // A pool with slots and nothing in them still reports, so "no rows" cannot be read as "not measured".
    expect(summary["quiet"]).toEqual({ slots: 1, held: 0, longestHoldSeconds: 0 });
});

// A thirty-minute hold that names no command cannot be acted on; the oldest holder is the one named.
test("a pool names the command holding its longest-held slot, and where it runs", () => {
    const counts = new Map([["heavy", 3]]);
    const stuck: HeldSlot = { ...holder("heavy", "slot.2", 7, 1_800), command: "npx vue-tsc --noEmit", cwd: `${HISTORY_ROOT}/worktrees/c-9` };
    const summary = summarisePools(counts, [holder("heavy", "slot.1", 6, 40), stuck, holder("heavy", "slot.3", 8, 1_799)]);
    expect(summary["heavy"]?.longestHolder).toEqual({ pid: 7, command: "npx vue-tsc --noEmit", cwd: `${HISTORY_ROOT}/worktrees/c-9` });
});

test("a holder whose process could not be read is still named by its pid", () => {
    const summary = summarisePools(new Map([["heavy", 1]]), [{ ...holder("heavy", "slot.1", 9, 60), command: undefined, cwd: undefined }]);
    expect(summary["heavy"]).toEqual({ slots: 1, held: 1, longestHoldSeconds: 60, longestHolder: { pid: 9, command: undefined, cwd: undefined } });
});
