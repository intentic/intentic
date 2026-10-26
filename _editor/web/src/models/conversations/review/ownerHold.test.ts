import type { GitChanges } from "@intentic/sandbox-contract/schemas/git/git";
import { ownerHoldOf, pathsByRepo } from "./ownerHold";

// The owner's half of a refused land, read off their own Changes: a deletion is told apart from an edit, because only
// a deletion has answers the board can carry out (keep it gone, or put it back).

const held = (repo: string, path: string) => ({ repo, path, reason: `workspace` as const });
const tree = (repos: GitChanges[`repos`]): GitChanges => ({ repos });
const repo = (name: string, sides: { staged?: { path: string; status: `deleted` | `modified` }[]; unstaged?: { path: string; status: `deleted` | `modified` }[] }) => ({
    repo: name,
    branch: `main`,
    conflicted: [],
    staged: sides.staged ?? [],
    unstaged: sides.unstaged ?? [],
});

it(`reads a file deleted on either side of the index as the owner's deletion, named when it is the only one`, () => {
    for (const side of [`staged`, `unstaged`] as const) {
        const hold = ownerHoldOf([held(`root`, `docs/a.md`)], tree([repo(`root`, { [side]: [{ path: `docs/a.md`, status: `deleted` }] })]));
        expect(hold).toEqual({ kind: `deleted`, blockers: [held(`root`, `docs/a.md`)], only: `docs/a.md` });
    }
});

it(`reads anything short of every file deleted as edits: an edit, a deletion among edits, a path the tree did not list`, () => {
    const both = repo(`root`, { staged: [{ path: `a.md`, status: `deleted` }], unstaged: [{ path: `b.md`, status: `modified` }] });
    expect(ownerHoldOf([held(`root`, `a.md`), held(`root`, `b.md`)], tree([both]))?.kind).toBe(`edited`);
    expect(ownerHoldOf([held(`root`, `c.md`)], tree([both]))?.kind).toBe(`edited`);
    // Deleted in the index, re-created on disk: not a deletion to keep.
    const recreated = repo(`root`, { staged: [{ path: `a.md`, status: `deleted` }], unstaged: [{ path: `a.md`, status: `modified` }] });
    expect(ownerHoldOf([held(`root`, `a.md`)], tree([recreated]))?.kind).toBe(`edited`);
});

it(`names a nested repo's file with its repo, and several files by none`, () => {
    const nested = tree([repo(`intentic`, { unstaged: [{ path: `x.ts`, status: `deleted` }, { path: `y.ts`, status: `deleted` }] })]);
    expect(ownerHoldOf([held(`intentic`, `x.ts`)], nested)?.only).toBe(`intentic/x.ts`);
    expect(ownerHoldOf([held(`intentic`, `x.ts`), held(`intentic`, `y.ts`)], nested)).toMatchObject({ kind: `deleted`, only: undefined });
});

it(`says nothing until both halves are read, or when the owner holds nothing`, () => {
    expect(ownerHoldOf([held(`root`, `a.md`)], undefined)).toBeUndefined();
    expect(ownerHoldOf([], tree([]))).toBeUndefined();
});

it(`groups paths per repo, since a commit or a discard is one repo's`, () => {
    expect([...pathsByRepo([held(`root`, `a`), held(`intentic`, `b`), held(`root`, `c`)])]).toEqual([
        [`root`, [`a`, `c`]],
        [`intentic`, [`b`]],
    ]);
});
