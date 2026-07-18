import { describe, expect, it } from "vitest";
import { type TreeEntry, vitestProjects } from "./useVitest";

const file = (path: string): TreeEntry => ({ name: path.split(`/`).at(-1) ?? path, path, type: `file` });
const dir = (path: string, children: TreeEntry[]): TreeEntry => ({
    name: path.split(`/`).at(-1) ?? path,
    path,
    type: `dir`,
    children,
});

// Repos mirroring the real shapes: a config package, a config-less package whose tests sit in src/, a
// package with neither, root-level evidence above any nested package.json, and a repo nested one level down
// (its id carries a slash).
const tree: TreeEntry[] = [
    dir(`mono`, [
        file(`mono/package.json`),
        dir(`mono/_libs`, [
            dir(`mono/_libs/engine`, [file(`mono/_libs/engine/package.json`), file(`mono/_libs/engine/vitest.config.ts`)]),
            dir(`mono/_libs/sandbox`, [
                file(`mono/_libs/sandbox/package.json`),
                dir(`mono/_libs/sandbox/src`, [file(`mono/_libs/sandbox/src/panels.test.ts`)]),
            ]),
            dir(`mono/_libs/ui`, [file(`mono/_libs/ui/package.json`)]),
        ]),
    ]),
    dir(`plain`, [file(`plain/package.json`), file(`plain/vitest.config.ts`)]),
    dir(`clients`, [dir(`clients/foo`, [file(`clients/foo/package.json`), file(`clients/foo/vitest.config.ts`)])]),
];

describe(`vitestProjects`, () => {
    it(`attributes evidence to the nearest package.json dir: configs, nested test files; packages without evidence excluded`, () => {
        expect(vitestProjects(tree, `mono`)).toEqual([`mono/_libs/engine`, `mono/_libs/sandbox`]);
    });

    it(`detects the repo root itself when evidence sits at the top level`, () => {
        expect(vitestProjects(tree, `plain`)).toEqual([`plain`]);
    });

    it(`resolves a nested repo id by walking the tree segment by segment`, () => {
        expect(vitestProjects(tree, `clients/foo`)).toEqual([`clients/foo`]);
    });

    it(`returns [] for an unknown repo`, () => {
        expect(vitestProjects(tree, `missing`)).toEqual([]);
    });
});
