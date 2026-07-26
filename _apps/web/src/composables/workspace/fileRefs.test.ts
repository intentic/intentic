import { beforeEach, describe, expect, it, vi } from "vitest";

// The module reaches for the workspace-tree query (container root) at import time — stub it so the path helpers
// can be exercised without the app graph. `queryData` is the seam the container-root lookup reads.
let queryData: { root?: string }[] = [];
vi.mock("../queryPersistence", () => ({
    queryClient: { getQueriesData: () => queryData.map((data) => [[], data] as const) },
}));

const { FILE_REF, parseRef, toWorkspacePath } = await import("./fileRefs");

beforeEach(() => {
    queryData = [];
});

describe(`parseRef`, () => {
    it(`splits colon and paren line[:col] tails to the 1-based line`, () => {
        expect(parseRef(`src/foo.ts:12:3`)).toEqual({ path: `src/foo.ts`, line: 12 });
        expect(parseRef(`src/foo.ts:9`)).toEqual({ path: `src/foo.ts`, line: 9 });
        expect(parseRef(`src/foo.ts(12,4)`)).toEqual({ path: `src/foo.ts`, line: 12 });
        expect(parseRef(`src/foo.ts`)).toEqual({ path: `src/foo.ts` });
    });
});

describe(`toWorkspacePath`, () => {
    it(`strips git-diff side prefixes so a copied diff path opens the real file`, () => {
        // Default a/ b/, mnemonicPrefix i/ w/ c/ o/, and --no-index 1/ 2/.
        for (const prefix of [`a`, `b`, `i`, `w`, `c`, `o`, `1`, `2`]) {
            expect(toWorkspacePath(`${prefix}/src/foo.ts`)).toBe(`src/foo.ts`);
        }
    });

    it(`leaves a bare relative path and an explicit ./ path untouched (no false prefix strip)`, () => {
        expect(toWorkspacePath(`src/foo.ts`)).toBe(`src/foo.ts`);
        expect(toWorkspacePath(`./src/foo.ts`)).toBe(`src/foo.ts`);
        // A real single-char first segment that isn't a diff marker survives.
        expect(toWorkspacePath(`x/foo.ts`)).toBe(`x/foo.ts`);
        // An explicit ./a/ is a tool-relative path, not a diff side — only the ./ is stripped.
        expect(toWorkspacePath(`./a/foo.ts`)).toBe(`a/foo.ts`);
    });

    it(`maps an absolute path under the container root to root-relative, and rejects paths outside it`, () => {
        queryData = [{ root: `/work` }];
        expect(toWorkspacePath(`/work/src/foo.ts`)).toBe(`src/foo.ts`);
        expect(toWorkspacePath(`/usr/lib/node.js`)).toBeUndefined();
        // A sibling directory whose name merely starts with the root is not inside it.
        expect(toWorkspacePath(`/workspace/src/foo.ts`)).toBeUndefined();
    });

    it(`can't map an absolute path until the tree (container root) has loaded`, () => {
        expect(toWorkspacePath(`/work/src/foo.ts`)).toBeUndefined();
    });
});

/* The grammar is shared by the terminal's link addon and the chat's markdown linkifier, so what it does and
 * does NOT match is a contract of its own: too loose and ordinary prose sprouts dead links. */
describe(`FILE_REF`, () => {
    const matchOf = (text: string): string | undefined => FILE_REF.exec(text)?.[0];

    it(`matches the reference forms tools and agents emit`, () => {
        expect(matchOf(`see src/foo.ts for details`)).toBe(`src/foo.ts`);
        expect(matchOf(`at ./src/foo.ts:42`)).toBe(`./src/foo.ts:42`);
        expect(matchOf(`/work/src/foo.ts:12:3`)).toBe(`/work/src/foo.ts:12:3`);
        expect(matchOf(`src/foo.ts(12,4)`)).toBe(`src/foo.ts(12,4)`);
    });

    it(`needs a directory segment and an extension, so ordinary words are never links`, () => {
        expect(matchOf(`run package.json through it`)).toBeUndefined();
        expect(matchOf(`import from @intentic-app/ui`)).toBeUndefined();
        expect(matchOf(`the and/or case`)).toBeUndefined();
    });

    it(`does not start mid-token inside a URL — the URL linker owns that`, () => {
        expect(matchOf(`https://example.com/foo.ts`)).toBeUndefined();
    });
});
