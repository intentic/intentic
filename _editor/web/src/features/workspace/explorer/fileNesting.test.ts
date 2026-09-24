import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { landingNest, nestSiblings } from "./fileNesting";

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

describe(`landingNest`, () => {
    const inApp = (name: string): WorkspaceTreeEntry => ({ name, path: `app/${name}`, type: `file` });
    const pkg = inApp(`package.json`);

    it(`opens the package.json a landed file folds under, and nothing for a folder or where nothing folds`, () => {
        const landedFile = [{ path: `app/notes.md`, type: `file` as const }];
        expect(landingNest(`app`, [pkg], landedFile)).toBe(`app/package.json`);
        expect(landingNest(`app`, [pkg], [{ path: `app/lib`, type: `dir` }])).toBeUndefined();
        expect(landingNest(`app`, [inApp(`README.md`)], landedFile)).toBeUndefined();
        expect(landingNest(``, [file(`package.json`)], [{ path: `notes.md`, type: `file` }])).toBe(`package.json`);
    });

    it(`opens a landed package.json that starts folding files already there, but not a lone one`, () => {
        const landed = [{ path: `app/package.json`, type: `file` as const }];
        expect(landingNest(`app`, [inApp(`README.md`)], landed)).toBe(`app/package.json`);
        expect(landingNest(`app`, [], landed)).toBeUndefined();
    });

    it(`opens an existing fold for a landing whose contents are not known yet`, () => {
        expect([landingNest(`app`, [pkg]), landingNest(`app`, [inApp(`README.md`)])]).toEqual([`app/package.json`, undefined]);
    });
});
