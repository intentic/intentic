import { engineFrom, parseOpen, workspacePath } from "./server.js";

describe(`an open request`, () => {
    it(`carries the path, the scope, the mode, the theme and the kept editor to resume`, () => {
        expect(parseOpen({ path: `docs/brief.docx`, mode: `edit`, theme: `dark`, resume: `tok` })).toEqual({
            path: `docs/brief.docx`,
            mode: `edit`,
            theme: `dark`,
            resume: `tok`,
            engine: `browser`,
        });
        expect(parseOpen({ path: `a/../brief.docx`, agent: `conv-1`, mode: `view` })).toEqual({
            path: `brief.docx`,
            agent: `conv-1`,
            mode: `view`,
            theme: `light`,
            engine: `browser`,
        });
    });

    it(`carries the engine, the app's language and its origin, and reads an unknown engine as the browser one`, () => {
        expect(parseOpen({ path: `brief.docx`, mode: `edit`, engine: `server`, lang: `de`, origin: `https://app.example` })).toEqual({
            path: `brief.docx`,
            mode: `edit`,
            theme: `light`,
            engine: `server`,
            lang: `de`,
            origin: `https://app.example`,
        });
        expect(engineFrom(`browser`)).toBe(`browser`);
        expect(engineFrom(`docker`)).toBe(`browser`);
        expect(engineFrom(undefined)).toBe(`browser`);
    });

    it(`refuses a path out of the workspace, a mode it does not know, and a resume that is not a token`, () => {
        expect(parseOpen({ path: `../etc/passwd`, mode: `edit` })).toBeUndefined();
        expect(parseOpen({ path: `brief.docx`, mode: `write` })).toBeUndefined();
        expect(parseOpen({ path: `brief.docx`, mode: `edit`, resume: 7 })).toBeUndefined();
        expect(parseOpen(undefined)).toBeUndefined();
        expect(workspacePath(`/abs.docx`)).toBeUndefined();
    });
});
