import { parseOpen, workspacePath } from "./server.js";

describe(`an open request`, () => {
    it(`carries the path, the scope, the mode, the theme and the kept editor to resume`, () => {
        expect(parseOpen({ path: `docs/brief.docx`, mode: `edit`, theme: `dark`, resume: `tok` })).toEqual({
            path: `docs/brief.docx`,
            mode: `edit`,
            theme: `dark`,
            resume: `tok`,
        });
        expect(parseOpen({ path: `a/../brief.docx`, agent: `conv-1`, mode: `view` })).toEqual({
            path: `brief.docx`,
            agent: `conv-1`,
            mode: `view`,
            theme: `light`,
        });
    });

    it(`refuses a path out of the workspace, a mode it does not know, and a resume that is not a token`, () => {
        expect(parseOpen({ path: `../etc/passwd`, mode: `edit` })).toBeUndefined();
        expect(parseOpen({ path: `brief.docx`, mode: `write` })).toBeUndefined();
        expect(parseOpen({ path: `brief.docx`, mode: `edit`, resume: 7 })).toBeUndefined();
        expect(parseOpen(undefined)).toBeUndefined();
        expect(workspacePath(`/abs.docx`)).toBeUndefined();
    });
});
