import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { ancestorDirs, revealTargets } from "./revealPath";

const entry = (path: string, type: "file" | "dir"): WorkspaceTreeEntry => ({ name: path.slice(path.lastIndexOf(`/`) + 1), path, type });
const file = (path: string): WorkspaceTreeEntry => entry(path, `file`);

describe(`ancestorDirs`, () => {
    it(`names every folder on the way down`, () => {
        expect(ancestorDirs(`src/api/routes.ts`)).toEqual([`src`, `src/api`]);
    });

    it(`has none for a root-level entry`, () => {
        expect(ancestorDirs(`README.md`)).toEqual([]);
    });
});

describe(`revealTargets`, () => {
    // The case the dir walk alone gets wrong: with nesting on, pnpm-lock.yaml has no row of its own until
    // package.json is expanded, so opening every folder above it would still reveal nothing.
    const siblings = [file(`web/package.json`), file(`web/pnpm-lock.yaml`), entry(`web/src`, `dir`)];

    it(`adds the sibling that folds the file when nesting is on`, () => {
        expect(revealTargets(`web/pnpm-lock.yaml`, siblings, true)).toEqual([`web`, `web/package.json`]);
    });

    it(`names folders only when nesting is off — every file has its own row`, () => {
        expect(revealTargets(`web/pnpm-lock.yaml`, siblings, false)).toEqual([`web`]);
    });

    it(`names folders only for a file that nothing folds`, () => {
        expect(revealTargets(`web/package.json`, siblings, true)).toEqual([`web`]);
        expect(revealTargets(`web/src`, siblings, true)).toEqual([`web`]);
    });

    it(`copes with a directory whose entries haven't loaded yet`, () => {
        expect(revealTargets(`web/pnpm-lock.yaml`, [], true)).toEqual([`web`]);
    });
});
