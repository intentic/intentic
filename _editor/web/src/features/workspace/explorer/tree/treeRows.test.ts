import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { describe, expect, it } from "bun:test";
import type { Provisional } from "../../files/provisionalEntries";
import { barrenChainOf, barrenChildren } from "../emptyDirs";
import {
    deadLink,
    dropDirOf,
    flattenRows,
    holdsRows,
    indexEntries,
    isUnlisted,
    linkTooltip,
    type MoreRow,
    provisionalTooltip,
    type Row,
    type RowSource,
} from "./treeRows";

// Pins how the listing becomes rows: what an open or a closed folder draws, how a filter, the toolbar's switches,
// nesting, a barren chain and the daemon's cuts change that, and what a row says about its link, drop and arrival.

const nameOf = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const dir = (path: string, children?: WorkspaceTreeEntry[]): WorkspaceTreeEntry => ({
    name: nameOf(path),
    path,
    type: `dir`,
    ...(children === undefined ? {} : { children }),
});
const file = (path: string): WorkspaceTreeEntry => ({ name: nameOf(path), path, type: `file` });

const TREE = [dir(`src`, [dir(`src/api`, [file(`src/api/routes.ts`)]), file(`src/main.ts`)]), file(`README.md`)];
const OFF = { showIgnored: false, hideTests: false, hideTechnical: false };

// A source over `tree` that changes nothing on its own: no filter, nothing open, nothing barren, the listing as given.
const sourceOf = (tree: readonly WorkspaceTreeEntry[], over: Partial<Omit<RowSource, `tree`>> = {}): RowSource => {
    const index = indexEntries(tree, (entry) => entry.children ?? []);
    return {
        tree,
        rootDir: ``,
        rootHidden: 0,
        filter: ``,
        expanded: new Set(),
        nesting: false,
        filters: OFF,
        childrenOf: (entry) => entry.children ?? [],
        hiddenIn: () => 0,
        isBarren: () => false,
        chainOf: (path) => ({ names: [nameOf(path)], tail: path }),
        entryAt: (path) => index.get(path),
        listing: (at, listed) => listed,
        ...over,
    };
};

// Each row as the reader meets it: indented by depth, `/` once it is open, `+N` for a marker.
const drawn = (rows: readonly (Row | MoreRow)[]): string[] =>
    rows.map((row) => `${`  `.repeat(row.depth)}${`more` in row ? `+${row.more}` : `${row.entry.path}${row.isExpanded ? `/` : ``}`}`);

describe(`the rows of a listing`, () => {
    it(`draws a closed folder as one row, and an open one with its contents a level deeper`, () => {
        expect(drawn(flattenRows(sourceOf(TREE)))).toEqual([`src`, `README.md`]);
        expect(drawn(flattenRows(sourceOf(TREE, { expanded: new Set([`src`, `src/api`]) })))).toEqual([
            `src/`,
            `  src/api/`,
            `    src/api/routes.ts`,
            `  src/main.ts`,
            `README.md`,
        ]);
    });

    it(`reads an unlisted folder's contents from the source, as the lazy listing hands them in`, () => {
        const unlisted = [dir(`vendor`), file(`README.md`)];
        const lazy = new Map([[`vendor`, [file(`vendor/lib.js`)]]]);
        const source = sourceOf(unlisted, { expanded: new Set([`vendor`]), childrenOf: (entry) => entry.children ?? lazy.get(entry.path) ?? [] });

        expect(drawn(flattenRows(source))).toEqual([`vendor/`, `  vendor/lib.js`, `README.md`]);
    });

    it(`marks what the daemon's budget cut, under an open folder and at the root, and only unfiltered`, () => {
        const cut = sourceOf(TREE, { expanded: new Set([`src`]), hiddenIn: (path) => (path === `src` ? 3 : 0), rootHidden: 2 });

        expect(flattenRows(cut).filter((row): row is MoreRow => `more` in row)).toEqual([
            { more: 3, depth: 1, key: `src#more` },
            { more: 2, depth: 0, key: `#root-more` },
        ]);
        expect(drawn(flattenRows({ ...cut, filter: `main` }))).toEqual([`src/`, `  src/main.ts`]);
    });

    it(`keeps, while filtering, a folder that matches or holds a match, drawn open whatever the open set says`, () => {
        expect(drawn(flattenRows(sourceOf(TREE, { filter: ` ROUTES ` })))).toEqual([`src/`, `  src/api/`, `    src/api/routes.ts`]);
        expect(drawn(flattenRows(sourceOf(TREE, { filter: `api` })))).toEqual([`src/`, `  src/api/`]);
        expect(drawn(flattenRows(sourceOf(TREE, { filter: `nothing` })))).toEqual([]);
    });

    it(`applies the toolbar's switches at every level`, () => {
        const ignored = [dir(`src`, [file(`src/main.ts`), { ...file(`src/main.js`), ignored: true }]), { ...dir(`dist`), ignored: true }];

        expect(drawn(flattenRows(sourceOf(ignored, { expanded: new Set([`src`]) })))).toEqual([`src/`, `  src/main.ts`]);
        expect(drawn(flattenRows(sourceOf(ignored, { expanded: new Set([`src`]), filters: { ...OFF, showIgnored: true } })))).toEqual([
            `src/`,
            `  src/main.ts`,
            `  src/main.js`,
            `dist`,
        ]);
    });

    it(`folds a package's files under package.json, opening like a folder, and never while filtering`, () => {
        const manifest = [dir(`src`, []), file(`package.json`), file(`tsconfig.json`), file(`README.md`)];
        const folded = sourceOf(manifest, { nesting: true });

        expect(drawn(flattenRows(folded))).toEqual([`src`, `package.json`]);
        expect(flattenRows(folded)[1]).toEqual({ entry: file(`package.json`), depth: 0, isExpanded: false, nest: true });
        expect(drawn(flattenRows({ ...folded, expanded: new Set([`package.json`]) }))).toEqual([
            `src`,
            `package.json/`,
            `  tsconfig.json`,
            `  README.md`,
        ]);
        expect(drawn(flattenRows({ ...folded, filter: `json` }))).toEqual([`package.json`, `tsconfig.json`]);
    });

    it(`joins what the source's listing adds to a folder, where the listing puts it`, () => {
        const arriving = sourceOf(TREE, {
            expanded: new Set([`src`]),
            listing: (at, listed) => (at === `src` ? [...listed, file(`src/notes.md`)] : listed),
        });

        expect(drawn(flattenRows(arriving))).toEqual([`src/`, `  src/api`, `  src/main.ts`, `  src/notes.md`, `README.md`]);
    });
});

describe(`a barren branch`, () => {
    const web = dir(`web`, [dir(`web/demo`, [dir(`web/demo/a`, []), dir(`web/demo/b`, [])])]);
    // `web` and `web/demo` are one chain; it stops at `web/demo`, which holds two empty folders.
    const BARREN = [`web`, `web/demo`, `web/demo/a`, `web/demo/b`];
    const barrenOf = (over: Partial<Omit<RowSource, `tree`>> = {}): RowSource =>
        sourceOf([web, file(`README.md`)], {
            isBarren: (path) => BARREN.includes(path),
            chainOf: (path) => barrenChainOf(path, barrenChildren(BARREN)),
            ...over,
        });

    it(`draws as one row named for its chain and keyed at its root, its tail kept for expanding`, () => {
        const [row] = flattenRows(barrenOf());

        expect(row).toEqual({ entry: web, depth: 0, isExpanded: false, barren: true, chain: [`web`, `demo`], chainTail: web.children?.[0] });
    });

    it(`expands from its tail, one level below the chain's row`, () => {
        const rows = flattenRows(barrenOf({ expanded: new Set([`web`]) }));

        expect(drawn(rows)).toEqual([`web/`, `  web/demo/a`, `  web/demo/b`, `README.md`]);
        expect(rows[1]).toEqual({ entry: dir(`web/demo/a`, []), depth: 1, isExpanded: false, barren: true, chainTail: dir(`web/demo/a`, []) });
    });

    it(`expands from its root when the chain runs past what the listing reached`, () => {
        const past = barrenOf({
            expanded: new Set([`web`]),
            chainOf: (path) => (path === `web` ? { names: [`web`, `gone`], tail: `web/gone` } : { names: [nameOf(path)], tail: path }),
        });
        const [row, ...below] = flattenRows(past);

        expect(row).toEqual({ entry: web, depth: 0, isExpanded: true, barren: true, chain: [`web`, `gone`] });
        expect(drawn(below)).toEqual([`  web/demo`, `README.md`]);
    });
});

describe(`the index and the row facts`, () => {
    it(`indexes every entry the children reach, lazy subtrees included`, () => {
        const lazy = new Map([[`src/api`, [file(`src/api/users.ts`)]]]);
        const index = indexEntries([dir(`src`, [dir(`src/api`)])], (entry) => entry.children ?? lazy.get(entry.path) ?? []);

        expect([...index.keys()]).toEqual([`src`, `src/api`, `src/api/users.ts`]);
    });

    it(`opens an archive like a folder, unlisted until it is asked what it holds`, () => {
        expect([holdsRows(file(`bundle.zip`)), holdsRows(file(`notes.gz`)), holdsRows(file(`a.ts`)), holdsRows(dir(`src`))]).toEqual([
            true,
            false,
            false,
            true,
        ]);
        expect([isUnlisted(file(`bundle.zip`)), isUnlisted(dir(`vendor`)), isUnlisted(dir(`empty`, [])), isUnlisted(file(`a.ts`))]).toEqual([
            true,
            true,
            false,
            false,
        ]);
    });

    it(`names a link's target, and a broken or outside one as such`, () => {
        expect(linkTooltip({ to: `../skills/github` })).toBe(`Link to ../skills/github`);
        expect(linkTooltip({ to: `../skills/gone`, state: `broken` })).toBe(`Link to ../skills/gone: there is nothing there`);
        expect(linkTooltip({ to: `/etc`, state: `outside` })).toBe(`Link to /etc: outside the workspace, so the sandbox won't open it`);
        expect([
            deadLink({ ...file(`a`), link: { to: `b` } }),
            deadLink({ ...file(`a`), link: { to: `b`, state: `broken` } }),
            deadLink(file(`a`)),
        ]).toEqual([false, true, false]);
    });

    it(`drops into a folder itself, and into a file's parent`, () => {
        const rowOf = (entry: WorkspaceTreeEntry): Row => ({ entry, depth: 0, isExpanded: false });

        expect([dropDirOf(rowOf(dir(`src/api`))), dropDirOf(rowOf(file(`src/api/routes.ts`))), dropDirOf(rowOf(file(`README.md`)))]).toEqual([
            `src/api`,
            `src/api`,
            ``,
        ]);
    });

    it(`says what is still happening to a provisional row, and that a failed upload failed`, () => {
        const at = (kind: Provisional[`kind`], state: Provisional[`state`]): Provisional => ({ kind, type: `file`, state });

        expect(
            [
                at(`upload`, `arriving`),
                at(`write`, `arriving`),
                at(`upload`, `landing`),
                at(`write`, `landing`),
                at(`upload`, `failed`),
                undefined,
            ].map(provisionalTooltip),
        ).toEqual([
            `Uploading…`,
            `Writing…`,
            `Uploaded — waiting for the workspace listing`,
            `Written — waiting for the workspace listing`,
            `Upload failed; the file isn't in the workspace`,
            undefined,
        ]);
    });
});
