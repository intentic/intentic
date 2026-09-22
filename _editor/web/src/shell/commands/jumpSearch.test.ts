import { it, expect } from "bun:test";
import { groupJumpRows, JUMP_KINDS, type JumpKind, jumpScopes, parseJumpQuery, type ScoredRow, scopedQuery, UNSCOPED_CAP } from "./jumpSearch";

// Pins the two rules that make one palette work for four kinds of row: the first character is the scope (and nothing
// else is), and a kind gets to the top by scoring there, never by being listed first.

const row = (kind: JumpKind, score: number): ScoredRow => ({ kind, score });
const kinds = (rows: readonly ScoredRow[], cap = UNSCOPED_CAP): readonly JumpKind[] => groupJumpRows(rows, cap).map((group) => group.kind);

it(`reads the scope off the first character and hands the rest on trimmed`, () => {
    expect(parseJumpQuery(`>  toggle panel `)).toEqual({ kind: `command`, text: `toggle panel` });
    expect(parseJumpQuery(`@main.ts`)).toEqual({ kind: `file`, text: `main.ts` });
    expect(parseJumpQuery(`#landing`)).toEqual({ kind: `agent`, text: `landing` });
    expect(parseJumpQuery(`$web-3`)).toEqual({ kind: `terminal`, text: `web-3` });
    expect(parseJumpQuery(`  landing page `)).toEqual({ kind: undefined, text: `landing page` });
});

// A session id arrives in four costumes and one of them is an absolute worktree path. No scope prefix may be a
// character such a paste can start with, or the palette would search for the path instead of opening the agent.
it(`leaves a pasted worktree path unscoped, so the session jump can still claim it`, () => {
    expect(parseJumpQuery(`/work/.intentic/worktrees/sleek-arrow-uzgj`)).toEqual({
        kind: undefined,
        text: `/work/.intentic/worktrees/sleek-arrow-uzgj`,
    });
});

it(`writes a chip's scope back into the field, which is what parses it again`, () => {
    for (const scope of jumpScopes()) {
        expect(parseJumpQuery(scopedQuery(scope.kind, `landing`))).toEqual({ kind: scope.kind, text: `landing` });
    }
});

it(`offers one chip per kind plus the unscoped one, each with a prefix the field can be narrowed by`, () => {
    const scopes = jumpScopes();
    expect(scopes.map((scope) => scope.kind)).toEqual([undefined, ...JUMP_KINDS]);
    expect(scopes.filter((scope) => scope.prefix === ``).length).toBe(1);
    expect(new Set(scopes.map((scope) => scope.prefix)).size).toBe(scopes.length);
});

it(`puts the kind holding the best row first, whatever its place in the fixed order`, () => {
    expect(kinds([row(`agent`, 0.6), row(`command`, 0.95), row(`file`, 0.8)])).toEqual([`command`, `file`, `agent`]);
});

it(`keeps the fixed order for kinds that score the same, which is the whole unqueried palette`, () => {
    expect(kinds([row(`command`, 0), row(`terminal`, 0), row(`file`, 0), row(`agent`, 0)])).toEqual(JUMP_KINDS);
});

it(`caps each kind on its own, so one long list cannot push another kind off the palette`, () => {
    const many = Array.from({ length: UNSCOPED_CAP + 3 }, () => row(`file`, 0.5));
    const groups = groupJumpRows([...many, row(`agent`, 0.4)], UNSCOPED_CAP);
    expect(groups.map((group) => [group.kind, group.rows.length])).toEqual([
        [`file`, UNSCOPED_CAP],
        [`agent`, 1],
    ]);
});

// Kinds are listed in blocks, so a near-miss riding along in a strong kind's block outranks another kind's good row
// without ever having scored like one.
it(`drops rows worth less than half the best answer, so near-misses cannot pad a block`, () => {
    const groups = groupJumpRows([row(`file`, 1), row(`file`, 0.3), row(`agent`, 0.8)], UNSCOPED_CAP);
    expect(groups.map((group) => [group.kind, group.rows.length])).toEqual([
        [`file`, 1],
        [`agent`, 1],
    ]);
});

it(`keeps every row when the whole list scores the same, including the unqueried palette`, () => {
    expect(groupJumpRows([row(`file`, 0), row(`file`, 0), row(`agent`, 0)], UNSCOPED_CAP).map((group) => group.rows.length)).toEqual([1, 2]);
});

it(`drops a kind with nothing to show rather than heading an empty block`, () => {
    expect(kinds([row(`terminal`, 0.3)])).toEqual([`terminal`]);
    expect(kinds([])).toEqual([]);
});
