import { beforeEach, describe, expect, it, vi } from "vitest";

// The module reaches for the workspace-tree query (container root + the file index a reference is matched
// against) — stub it so the path helpers can be exercised without the app graph. `queryData` is the seam both
// lookups read.
let queryData: { root?: string; tree?: unknown[] }[] = [];
vi.mock("../queryPersistence", () => ({
    queryClient: { getQueriesData: () => queryData.map((data) => [[], data] as const) },
}));

const { FILE_REF, parseRef, resolveInTree, toWorkspacePath } = await import("./fileRefs");

// A tree response holding exactly these files, nested the way the daemon returns them.
const treeOf = (root: string, ...files: string[]): { root: string; tree: unknown[]; hidden: number } => {
    const tree: unknown[] = [];
    for (const file of files) {
        const segments = file.split(`/`);
        let level = tree;
        segments.forEach((name, depth) => {
            const path = segments.slice(0, depth + 1).join(`/`);
            if (depth === segments.length - 1) {
                level.push({ name, path, type: `file` });
                return;
            }
            const dir = (level as { name: string; children: unknown[] }[]).find((entry) => entry.name === name) ?? {
                name,
                path,
                type: `dir`,
                children: [],
            };
            if (!level.includes(dir)) {
                level.push(dir);
            }
            level = dir.children;
        });
    }
    return { root, tree, hidden: 0 };
};

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

    // The GitHub anchor a model writes when it reaches for the markdown-link form. Unparsed, the fragment goes
    // into the path and the link opens nothing.
    it(`reads a #L anchor, range and all`, () => {
        expect(parseRef(`src/foo.ts#L12`)).toEqual({ path: `src/foo.ts`, line: 12 });
        expect(parseRef(`src/foo.ts#L12-L20`)).toEqual({ path: `src/foo.ts`, line: 12 });
        expect(parseRef(`src/foo.ts#L12-20`)).toEqual({ path: `src/foo.ts`, line: 12 });
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
        queryData = [treeOf(`/work`)];
        expect(toWorkspacePath(`/work/src/foo.ts`)).toBe(`src/foo.ts`);
        expect(toWorkspacePath(`/usr/lib/node.js`)).toBeUndefined();
        // A sibling directory whose name merely starts with the root is not inside it — and nothing in the
        // workspace ends in that path either, so it stays unmapped.
        expect(toWorkspacePath(`/workspace/src/foo.ts`)).toBeUndefined();
    });

    it(`maps an isolated turn's worktree path onto the file it mirrors`, () => {
        // An isolated agent runs in /history/worktrees/<id>, which mirrors the workspace layout below its lead.
        queryData = [treeOf(`/work`, `_apps/web/src/foo.ts`)];
        expect(toWorkspacePath(`/history/worktrees/agent-7/_apps/web/src/foo.ts`)).toBe(`_apps/web/src/foo.ts`);
    });

    it(`can't map an absolute path until the tree (container root) has loaded`, () => {
        expect(toWorkspacePath(`/work/src/foo.ts`)).toBeUndefined();
    });
});

/* The fix for the way models actually write paths: having established an area, an answer names a file by the
 * tail of its path, and read literally that opens nothing. */
describe(`resolveInTree`, () => {
    it(`matches an abbreviated path onto the file it names`, () => {
        queryData = [treeOf(`/work`, `_apps/web/src/pages/workspace/WorkspaceDesktop.vue`)];
        expect(resolveInTree(`pages/workspace/WorkspaceDesktop.vue`)).toBe(`_apps/web/src/pages/workspace/WorkspaceDesktop.vue`);
    });

    it(`keeps a path that already names a real file, even where a deeper file shares its tail`, () => {
        queryData = [treeOf(`/work`, `src/foo.ts`, `_apps/web/src/foo.ts`)];
        expect(resolveInTree(`src/foo.ts`)).toBe(`src/foo.ts`);
    });

    it(`takes the shallowest of several matches — the app's file, not a copy buried in a fixture tree`, () => {
        queryData = [treeOf(`/work`, `_apps/web/test/fixtures/deep/pages/Foo.vue`, `_apps/web/src/pages/Foo.vue`)];
        expect(resolveInTree(`pages/Foo.vue`)).toBe(`_apps/web/src/pages/Foo.vue`);
    });

    it(`answers nothing when no file ends in the reference, leaving the daemon to try`, () => {
        queryData = [treeOf(`/work`, `src/foo.ts`)];
        expect(resolveInTree(`src/bar.ts`)).toBeUndefined();
    });

    it(`answers nothing before the tree has loaded`, () => {
        expect(resolveInTree(`src/foo.ts`)).toBeUndefined();
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
        expect(matchOf(`import from @intentic/ui`)).toBeUndefined();
        expect(matchOf(`the and/or case`)).toBeUndefined();
    });

    it(`does not start mid-token inside a URL — the URL linker owns that`, () => {
        expect(matchOf(`https://example.com/foo.ts`)).toBeUndefined();
    });
});
