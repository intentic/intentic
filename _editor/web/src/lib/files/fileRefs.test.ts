import { WORKSPACE_ROOT } from "@intentic/constants";

import { treeCache, treeCacheModule } from "../../testing/treeCache";

// A real query cache, the tree seeded under the explorer's own key (testing/treeCache.ts), so a reader that drifts from
// that key fails here rather than in every chat.
jest.mock("../queryPersistence", treeCacheModule);

const { FILE_REF, parseRef, resolveInTree, toWorkspacePath } = await import("./fileRefs");
const { workspaceTreeKeyFor } = await import("./workspaceTreeCache");
const { workspaceTreeKey } = await import("../../models/workspace/tree/workspaceTreeKey");
const { workspaceAgent } = await import("../../app/workspaceScope");

// The explorer's fetch landing for one scope, the shared tree when none is named.
const seed = (tree: { root: string; tree: unknown[] }, agent?: string): void => {
    treeCache.setQueryData(workspaceTreeKeyFor(agent), tree);
};

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
    treeCache.clear();
    workspaceAgent.value = undefined;
});

describe(`parseRef`, () => {
    it(`splits colon and paren line[:col] tails to the 1-based line`, () => {
        expect(parseRef(`src/foo.ts:12:3`)).toEqual({ path: `src/foo.ts`, line: 12 });
        expect(parseRef(`src/foo.ts:9`)).toEqual({ path: `src/foo.ts`, line: 9 });
        expect(parseRef(`src/foo.ts(12,4)`)).toEqual({ path: `src/foo.ts`, line: 12 });
        expect(parseRef(`src/foo.ts`)).toEqual({ path: `src/foo.ts` });
    });

    it(`reads a #L anchor, range and all`, () => {
        expect(parseRef(`src/foo.ts#L12`)).toEqual({ path: `src/foo.ts`, line: 12 });
        expect(parseRef(`src/foo.ts#L12-L20`)).toEqual({ path: `src/foo.ts`, line: 12 });
        expect(parseRef(`src/foo.ts#L12-20`)).toEqual({ path: `src/foo.ts`, line: 12 });
    });
});

describe(`toWorkspacePath`, () => {
    it(`strips git-diff side prefixes so a copied diff path opens the real file`, () => {
        // a/b are git's default prefixes, i/w/c/o mnemonicPrefix, 1/2 --no-index.
        for (const prefix of [`a`, `b`, `i`, `w`, `c`, `o`, `1`, `2`]) {
            expect(toWorkspacePath(`${prefix}/src/foo.ts`)).toBe(`src/foo.ts`);
        }
    });

    it(`leaves a bare relative path and an explicit ./ path untouched (no false prefix strip)`, () => {
        expect(toWorkspacePath(`src/foo.ts`)).toBe(`src/foo.ts`);
        expect(toWorkspacePath(`./src/foo.ts`)).toBe(`src/foo.ts`);
        // A real single-char first segment, not a diff marker, survives untouched.
        expect(toWorkspacePath(`x/foo.ts`)).toBe(`x/foo.ts`);
        // `./a/` is tool-relative, not a diff side: only the `./` strips, the `a` stays.
        expect(toWorkspacePath(`./a/foo.ts`)).toBe(`a/foo.ts`);
    });

    it(`maps an absolute path under the container root to root-relative, and rejects paths outside it`, () => {
        seed(treeOf(WORKSPACE_ROOT));
        expect(toWorkspacePath(`/work/src/foo.ts`)).toBe(`src/foo.ts`);
        expect(toWorkspacePath(`/usr/lib/node.js`)).toBeUndefined();
        // A sibling dir starting with the root's name isn't inside it; nothing else matches, so it stays unmapped.
        expect(toWorkspacePath(`/workspace/src/foo.ts`)).toBeUndefined();
    });

    it(`maps an isolated turn's worktree path onto the file it mirrors`, () => {
        // Isolated agent worktree lives at /history/worktrees/<id>, mirroring the workspace layout below it.
        seed(treeOf(WORKSPACE_ROOT, `_editor/web/src/foo.ts`));
        expect(toWorkspacePath(`/history/worktrees/agent-7/_editor/web/src/foo.ts`)).toBe(`_editor/web/src/foo.ts`);
    });

    it(`maps a container path in a conversation's words by any held tree's root, its own not fetched yet`, () => {
        seed(treeOf(WORKSPACE_ROOT));
        expect(toWorkspacePath(`/work/intentic/src/foo.ts`, { agent: `c-1` })).toBe(`intentic/src/foo.ts`);
    });

    it(`can't map an absolute path until the tree (container root) has loaded`, () => {
        expect(toWorkspacePath(`/work/src/foo.ts`)).toBeUndefined();
    });
});

// Models name a file by the tail of its path once an area's established; read literally, that opens nothing.
describe(`resolveInTree`, () => {
    it(`matches an abbreviated path onto the file it names`, () => {
        seed(treeOf(WORKSPACE_ROOT, `_editor/web/src/pages/workspace/WorkspaceDesktop.vue`));
        expect(resolveInTree(`pages/workspace/WorkspaceDesktop.vue`)).toBe(`_editor/web/src/pages/workspace/WorkspaceDesktop.vue`);
    });

    it(`keeps a path that already names a real file, even where a deeper file shares its tail`, () => {
        seed(treeOf(WORKSPACE_ROOT, `src/foo.ts`, `_editor/web/src/foo.ts`));
        expect(resolveInTree(`src/foo.ts`)).toBe(`src/foo.ts`);
    });

    it(`takes the shallowest of several matches: the app's file, not a copy buried in a fixture tree`, () => {
        seed(treeOf(WORKSPACE_ROOT, `_editor/web/test/fixtures/deep/pages/Foo.vue`, `_editor/web/src/pages/Foo.vue`));
        expect(resolveInTree(`pages/Foo.vue`)).toBe(`_editor/web/src/pages/Foo.vue`);
    });

    it(`answers nothing when no file ends in the reference, leaving the daemon to try`, () => {
        seed(treeOf(WORKSPACE_ROOT, `src/foo.ts`));
        expect(resolveInTree(`src/bar.ts`)).toBeUndefined();
    });

    it(`answers nothing before the tree has loaded`, () => {
        expect(resolveInTree(`src/foo.ts`)).toBeUndefined();
    });

    it(`reads the tree the explorer holds, under the key the explorer stores it by`, () => {
        treeCache.setQueryData(workspaceTreeKey(), treeOf(WORKSPACE_ROOT, `_editor/web/src/pages/Foo.vue`));
        expect(resolveInTree(`pages/Foo.vue`)).toBe(`_editor/web/src/pages/Foo.vue`);
    });

    it(`resolves in the copy it is asked about, never in another copy that happens to be held`, () => {
        // The conversation's checkout has a file the shared tree has never had, and the shared tree a same-named one.
        seed(treeOf(WORKSPACE_ROOT, `intentic/_os/installer/bib-config.toml`, `other/installer/config.toml`));
        seed(treeOf(WORKSPACE_ROOT, `intentic/_os/installer/bib-config.toml`, `intentic/_os/installer/config.toml`), `c-1`);
        expect(resolveInTree(`installer/config.toml`, { agent: `c-1` })).toBe(`intentic/_os/installer/config.toml`);
        expect(resolveInTree(`installer/config.toml`, { agent: undefined })).toBe(`other/installer/config.toml`);
        // A copy whose tree was never fetched answers nothing, leaving the daemon to look in the right place.
        expect(resolveInTree(`installer/config.toml`, { agent: `c-2` })).toBeUndefined();
    });

    it(`defaults to the Workspace's own copy`, () => {
        seed(treeOf(WORKSPACE_ROOT, `intentic/src/only-here.ts`), `c-1`);
        expect(resolveInTree(`src/only-here.ts`)).toBeUndefined();
        workspaceAgent.value = `c-1`;
        expect(resolveInTree(`src/only-here.ts`)).toBe(`intentic/src/only-here.ts`);
    });
});

// Grammar shared by the terminal's link addon and chat's markdown linkifier: too loose and ordinary prose sprouts dead
// links.
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
        // A fraction or a version range is prose, not a path: the extension has to hold a letter.
        expect(matchOf(`ratio 3/4.5`)).toBeUndefined();
        expect(matchOf(`see v1.2/3.4 for details`)).toBeUndefined();
        expect(matchOf(`scores 10/9.5 overall`)).toBeUndefined();
    });

    it(`still matches an extension that merely starts with a digit`, () => {
        expect(matchOf(`dist/archive.7z`)).toBe(`dist/archive.7z`);
    });

    it(`does not start mid-token inside a URL: the URL linker owns that`, () => {
        expect(matchOf(`https://example.com/foo.ts`)).toBeUndefined();
    });
});
