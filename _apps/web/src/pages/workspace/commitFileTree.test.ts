import { describe, expect, it } from "vitest";
import type { GitChange } from "@intentic-app/api-contract";
import { buildFileTree, flattenFileTree, type TreeNode } from "./commitFileTree";

const file = (path: string): GitChange => ({ path, status: "modified", additions: 1, deletions: 0 });
const childrenOf = (node: TreeNode | undefined): readonly TreeNode[] => (node?.type === "dir" ? node.children : []);

describe(`buildFileTree`, () => {
    it(`compacts single-child directory chains into one row`, () => {
        const tree = buildFileTree([file(`a/b/c/x.ts`), file(`a/b/c/y.ts`)]);
        // a → b → c is a single chain; c holds two files, so the whole chain compacts to one node.
        expect(tree).toHaveLength(1);
        expect(tree[0]).toMatchObject({ type: `dir`, name: `a / b / c`, path: `a/b/c` });
        expect(childrenOf(tree[0]).map((node) => node.name)).toEqual([`x.ts`, `y.ts`]);
    });

    it(`stops compaction where a directory also holds files, dirs before files`, () => {
        const tree = buildFileTree([file(`a/b/x.ts`), file(`a/b/c/y.ts`)]);
        expect(tree[0]).toMatchObject({ name: `a / b`, path: `a/b` });
        const kids = childrenOf(tree[0]);
        expect(kids.map((node) => node.type)).toEqual([`dir`, `file`]); // dir "c" before file "x.ts"
        expect(kids[0]).toMatchObject({ type: `dir`, name: `c`, path: `a/b/c` });
        expect(kids[1]).toMatchObject({ type: `file`, name: `x.ts` });
    });
});

describe(`flattenFileTree`, () => {
    it(`emits nested rows expanded, and hides a collapsed dir's subtree`, () => {
        const tree = buildFileTree([file(`a/x.ts`), file(`a/b/y.ts`)]);
        expect(flattenFileTree(tree, new Set()).map((row) => `${row.kind}:${row.name}@${row.depth}`)).toEqual([
            `dir:a@0`,
            `dir:b@1`,
            `file:y.ts@2`,
            `file:x.ts@1`,
        ]);
        // Collapsing "a" hides everything beneath it.
        expect(flattenFileTree(tree, new Set([`a`])).map((row) => row.name)).toEqual([`a`]);
    });
});
