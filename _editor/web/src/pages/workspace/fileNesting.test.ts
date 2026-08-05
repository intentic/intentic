import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { nestSiblings } from "./fileNesting";

const file = (name: string): WorkspaceTreeEntry => ({ name, path: name, type: `file` });
const dir = (name: string): WorkspaceTreeEntry => ({ name, path: name, type: `dir`, children: [] });

describe(`nestSiblings`, () => {
    it(`folds sibling files under package.json, directories first`, () => {
        const pkg = file(`package.json`);
        const result = nestSiblings([dir(`node_modules`), file(`.env`), pkg, dir(`src`), file(`turbo.json`)]);
        expect(result.map((item) => item.entry.name)).toEqual([`node_modules`, `src`, `package.json`]);
        expect(result[2]?.nested?.map((node) => node.name)).toEqual([`.env`, `turbo.json`]);
    });

    it(`passes through when there is no package.json`, () => {
        const entries = [dir(`src`), file(`README.md`), file(`turbo.json`)];
        expect(nestSiblings(entries)).toEqual(entries.map((entry) => ({ entry })));
    });

    it(`passes through when package.json is the only file`, () => {
        const entries = [dir(`src`), file(`package.json`)];
        expect(nestSiblings(entries)).toEqual(entries.map((entry) => ({ entry })));
    });

    it(`ignores a directory named package.json`, () => {
        const entries = [dir(`package.json`), file(`README.md`)];
        expect(nestSiblings(entries)).toEqual(entries.map((entry) => ({ entry })));
    });
});
