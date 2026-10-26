import { PersonaPowersSchema } from "./personas.js";
import { capPowers, ceilingLimits, ceilingWithholds, ceilingWords, intersectCeilings } from "./tool-ceiling.js";

// A ceiling is an upper bound per shelf: an answer left out limits nothing, and two held together keep the lower of each.

const FULL = PersonaPowersSchema.parse({});

describe(`intersectCeilings`, () => {
    it(`keeps the lower answer of each shelf`, () => {
        expect(intersectCeilings({ files: `read`, shell: false }, { files: `none`, web: false })).toEqual({ files: `none`, shell: false, web: false });
        expect(intersectCeilings({ files: `write` }, { files: `read` })).toEqual({ files: `read` });
    });

    it(`reads undefined as no ceiling at all`, () => {
        expect(intersectCeilings(undefined, { shell: false })).toEqual({ shell: false });
        expect(intersectCeilings({ code: false }, undefined)).toEqual({ code: false });
        expect(intersectCeilings(undefined, undefined)).toBeUndefined();
    });

    it(`drops a shelf both answer true, since true is no limit`, () => {
        expect(intersectCeilings({ shell: true }, { shell: true })).toEqual({});
    });
});

describe(`capPowers`, () => {
    it(`lowers a persona's shelves to the ceiling and keeps its connector lists`, () => {
        const powers = { ...FULL, connectors: [`github`] };
        expect(capPowers(powers, { files: `read`, shell: false, delegate: false })).toEqual({
            ...powers,
            files: `read`,
            shell: false,
            delegate: false,
        });
    });

    it(`never raises a shelf the persona switched off`, () => {
        const readOnly = { ...FULL, files: `read` as const, shell: false };
        expect(capPowers(readOnly, { files: `write`, shell: true })).toEqual(readOnly);
    });

    it(`returns the persona's own shelves when the ceiling limits nothing`, () => {
        expect(capPowers(FULL, undefined)).toBe(FULL);
        expect(capPowers(FULL, { files: `write`, web: true })).toBe(FULL);
    });
});

describe(`ceilingLimits and ceilingWithholds`, () => {
    it(`counts only an answer below the top as a limit`, () => {
        expect(ceilingLimits(undefined)).toBe(false);
        expect(ceilingLimits({ files: `write`, shell: true })).toBe(false);
        expect(ceilingLimits({ files: `read` })).toBe(true);
        expect(ceilingLimits({ browser: false })).toBe(true);
    });

    it(`withholds files below write, and a switch answered false`, () => {
        expect(ceilingWithholds({ files: `read` }, `files`)).toBe(true);
        expect(ceilingWithholds({ files: `write` }, `files`)).toBe(false);
        expect(ceilingWithholds({ shell: false }, `shell`)).toBe(true);
        expect(ceilingWithholds({ shell: false }, `web`)).toBe(false);
        expect(ceilingWithholds(undefined, `shell`)).toBe(false);
    });
});

describe(`ceilingWords`, () => {
    it(`names each limit in the order the shelves are listed`, () => {
        expect(ceilingWords({ files: `read`, shell: false, sandbox: false })).toEqual([`read-only files`, `no commands`, `no sandbox settings`]);
        expect(ceilingWords({ files: `none` })).toEqual([`no files`]);
        expect(ceilingWords(undefined)).toEqual([]);
    });
});
