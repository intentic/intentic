import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { describe, expect, it } from "vitest";
import { contentMatches, nameMatches, RESULTS_CAP, whereOf } from "./homeResults";

const file = (path: string): WorkspaceTreeEntry => ({ name: path.slice(path.lastIndexOf(`/`) + 1), path, type: `file` });
const dir = (path: string, children?: readonly WorkspaceTreeEntry[]): WorkspaceTreeEntry => ({
    name: path.slice(path.lastIndexOf(`/`) + 1),
    path,
    type: `dir`,
    ...(children === undefined ? {} : { children }),
});

// The fixture tree, none of it real: a `web` repo whose `src` holds two files, a `docs` the walk left unopened, and a
// readme beside them.
const lazy = new Map<string, readonly WorkspaceTreeEntry[]>([[`web/docs`, [file(`web/docs/checkout.md`)]]]);
const src = dir(`web/src`, [file(`web/src/App.tsx`), file(`web/src/checkout.ts`)]);
const docs = dir(`web/docs`);
const web = dir(`web`, [src, docs, file(`web/README.md`)]);
const childrenOf = (folder: WorkspaceTreeEntry): readonly WorkspaceTreeEntry[] | undefined => folder.children ?? lazy.get(folder.path);
const all = (): boolean => true;
const names = (results: readonly { entry: WorkspaceTreeEntry }[]): string[] => results.map((result) => result.entry.path);

describe(`name matches under the open folder`, () => {
    it(`finds names at any depth, case-blind, and says which folder each sits in`, () => {
        const results = nameMatches(`CHECK`, `web`, web.children ?? [], childrenOf, all);
        expect(names(results)).toEqual([`web/src/checkout.ts`, `web/docs/checkout.md`]);
        expect(results.map((result) => result.where)).toEqual([`src`, `docs`]);
    });

    it(`walks a lazy listing the reader has opened, and not one it has not`, () => {
        const unopened = new Map<string, readonly WorkspaceTreeEntry[]>();
        const results = nameMatches(`checkout`, `web`, web.children ?? [], (folder) => folder.children ?? unopened.get(folder.path), all);
        expect(names(results)).toEqual([`web/src/checkout.ts`]);
    });

    it(`leaves a hidden folder and everything in it out`, () => {
        const results = nameMatches(`checkout`, `web`, web.children ?? [], childrenOf, (entry) => entry.path !== `web/src`);
        expect(names(results)).toEqual([`web/docs/checkout.md`]);
    });

    it(`matches folders too, and reads an empty query as no query`, () => {
        expect(names(nameMatches(`src`, `web`, web.children ?? [], childrenOf, all))).toEqual([`web/src`]);
        expect(nameMatches(`   `, `web`, web.children ?? [], childrenOf, all)).toEqual([]);
    });

    it(`stops at the cap`, () => {
        const many = Array.from({ length: RESULTS_CAP + 50 }, (_, index) => file(`f${index}.ts`));
        expect(nameMatches(`f`, ``, many, childrenOf, all)).toHaveLength(RESULTS_CAP);
    });
});

describe(`content matches under the open folder`, () => {
    const entryAt = (path: string): WorkspaceTreeEntry | undefined => (path === `web/src/App.tsx` ? file(path) : undefined);

    it(`keeps the files under the open folder and draws an unlisted one from its path`, () => {
        const results = contentMatches([`web/src/App.tsx`, `api/src/server.ts`, `web/notes.txt`], `web`, entryAt);
        expect(names(results)).toEqual([`web/src/App.tsx`, `web/notes.txt`]);
        expect(results[1]?.entry).toEqual({ name: `notes.txt`, path: `web/notes.txt`, type: `file` });
        expect(results.map((result) => result.where)).toEqual([`src`, ``]);
    });

    it(`keeps everything at the root`, () => {
        expect(names(contentMatches([`web/src/App.tsx`, `api/src/server.ts`], ``, entryAt))).toEqual([`web/src/App.tsx`, `api/src/server.ts`]);
    });
});

describe(`where an entry sits`, () => {
    it(`is the folder relative to the open one`, () => {
        expect(whereOf(`web/src/App.tsx`, `web`)).toBe(`src`);
        expect(whereOf(`web/README.md`, `web`)).toBe(``);
        expect(whereOf(`web/src/App.tsx`, ``)).toBe(`web/src`);
    });
});
