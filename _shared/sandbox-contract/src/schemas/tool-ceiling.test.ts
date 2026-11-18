import { RolePowersSchema } from "./roles.js";
import { capPowers, ceilingLimits, ceilingWithholds, ceilingWords, intersectCeilings } from "./tool-ceiling.js";

// A ceiling is an upper bound per shelf: an answer left out limits nothing, and two held together keep the lower of each.

const FULL = RolePowersSchema.parse({});

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
    it(`lowers a turn's shelves to the ceiling`, () => {
        expect(capPowers(FULL, { files: `read`, shell: false, delegate: false })).toEqual({
            ...FULL,
            files: `read`,
            shell: false,
            delegate: false,
        });
    });

    it(`keeps only the extensions both the shelves and the ceiling allow`, () => {
        expect(capPowers(FULL, { extensions: [`acme.crm`] }).extensions).toEqual([`acme.crm`]);
        expect(capPowers({ ...FULL, extensions: [`acme.crm`, `acme.mail`] }, { extensions: [`acme.mail`] }).extensions).toEqual([`acme.mail`]);
        expect(intersectCeilings({ extensions: [`a`, `b`] }, { extensions: [`b`, `c`] })).toEqual({ extensions: [`b`] });
        expect(ceilingLimits({ extensions: [] })).toBe(true);
    });

    it(`never raises a shelf already off`, () => {
        const readOnly = { ...FULL, files: `read` as const, shell: false };
        expect(capPowers(readOnly, { files: `write`, shell: true })).toEqual(readOnly);
    });

    it(`returns the shelves as they were when the ceiling limits nothing`, () => {
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
