import type { GitChange, RepoChanges, ScratchPath } from "@intentic/sandbox-contract/schemas/git/git";
import { recordableTotal } from "../../../../models/workspace/changes/scratchFolders";
import type { ChangedFile } from "./changedFiles";
import { discardedRepos, discardTargets, fileRows, folderRows, folderTarget, savedRepos } from "./changedFiles";

const file = (repo: string, path: string, from?: string): ChangedFile => ({
    key: JSON.stringify([repo, path]),
    repo,
    path,
    label: repo === `root` ? path : `${repo}/${path}`,
    status: from === undefined ? `modified` : `renamed`,
    side: `unstaged`,
    scratch: false,
    ...(from === undefined ? {} : { from }),
});

describe(`discardTargets`, () => {
    test(`sends one target a repository, naming each file a heading holds`, () => {
        expect(discardTargets([file(`root`, `a.md`), file(`site`, `index.html`), file(`root`, `b.md`)])).toEqual([
            { repo: `root`, paths: [`a.md`, `b.md`] },
            { repo: `site`, paths: [`index.html`] },
        ]);
    });

    test(`names both legs of a rename, or undoing it would leave the old name deleted`, () => {
        expect(discardTargets([file(`root`, `new.md`, `old.md`)])).toEqual([{ repo: `root`, paths: [`new.md`, `old.md`] }]);
    });

    test(`sends nothing for no files, rather than an empty path list git would read as the whole repository`, () => {
        expect(discardTargets([])).toEqual([]);
    });
});

const repoWith = (over: Partial<RepoChanges>): RepoChanges => ({ repo: `root`, conflicted: [], staged: [], unstaged: [], ...over });
const added = (path: string): GitChange => ({ path, status: `added` });
const BUILD: ScratchPath = { path: `build/`, reason: `bulk`, files: 4992, bytes: 1_288_490_189 };

describe(`scratch folders`, () => {
    const tree = repoWith({
        unstaged: [added(`src/new.ts`), added(`build/a.wasm`), added(`build/b.br`), added(`notes.log`)],
        scratch: [BUILD, { path: `notes.log`, reason: `byproduct`, files: 1, bytes: 10 }],
    });

    test(`fileRows leaves out what a folder stands for, and flags a scratch file that stays as an ordinary row`, () => {
        expect(fileRows(tree).map((row) => [row.path, row.scratch])).toEqual([
            [`src/new.ts`, false],
            [`notes.log`, true],
        ]);
    });

    test(`folderRows is one row per directory entry, a file entry never one`, () => {
        expect(folderRows(tree)).toEqual([{ key: JSON.stringify([`root`, `build/`]), repo: `root`, label: `build/`, entry: BUILD }]);
        expect(folderRows(repoWith({ repo: `site`, scratch: [BUILD] }))[0]?.label).toBe(`site/build/`);
    });

    test(`deleting a folder row sends its own path, not the files under it`, () => {
        const [row] = folderRows(repoWith({ repo: `site`, scratch: [BUILD] }));
        expect(folderTarget(row!)).toEqual({ repo: `site`, paths: [`build/`] });
    });

    test(`counts what a save records: not a folder's files, listed or cut, nor a scratch file`, () => {
        expect(recordableTotal(tree)).toBe(1);
        // 2 listed under the folder, 4,990 cut: all of them the folder's.
        expect(recordableTotal({ ...tree, truncated: { staged: 0, unstaged: 4990 } })).toBe(1);
        // A cut the folder does not explain is a row a save would record.
        expect(recordableTotal({ ...tree, truncated: { staged: 3, unstaged: 4995 } })).toBe(1 + 3 + 5);
    });

    test(`a repository holding only scratch has nothing to save, but is still there to throw away`, () => {
        const only = repoWith({ unstaged: [added(`build/a.wasm`)], scratch: [BUILD] });
        expect(savedRepos([only, tree])).toEqual([{ repo: `root` }]);
        expect(savedRepos([only])).toEqual([]);
        expect(discardedRepos([only])).toEqual([{ repo: `root` }]);
        expect(discardedRepos([repoWith({})])).toEqual([]);
    });
});
