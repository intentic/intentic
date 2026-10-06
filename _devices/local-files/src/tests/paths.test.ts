import { cleanRelPath, segmentsOf, within } from "../paths.js";

describe(`within`, () => {
    it(`counts the root and everything under it, and nothing beside or above it`, () => {
        expect(within(`/home/me/project`, `/home/me/project`)).toBe(true);
        expect(within(`/home/me/project`, `/home/me/project/docs/a.md`)).toBe(true);
        expect(within(`/home/me/project`, `/home/me/project-2/a.md`)).toBe(false);
        expect(within(`/home/me/project`, `/home/me`)).toBe(false);
        expect(within(`/home/me/project`, `/etc/passwd`)).toBe(false);
    });

    // `..name` is a file name anyone may use; only a whole `..` segment leaves.
    it(`reads a name that starts with two dots as a name`, () => {
        expect(within(`/home/me/project`, `/home/me/project/..notes`)).toBe(true);
    });
});

describe(`segmentsOf`, () => {
    it(`splits a root-relative path and drops empty and current-folder segments`, () => {
        expect(segmentsOf(`docs//a.md`)).toEqual([`docs`, `a.md`]);
        expect(segmentsOf(`./docs/./a.md`)).toEqual([`docs`, `a.md`]);
        expect(segmentsOf(``)).toEqual([]);
    });

    it(`refuses anything that could leave the root by spelling alone`, () => {
        expect(segmentsOf(`../etc/passwd`)).toBeUndefined();
        expect(segmentsOf(`docs/../../etc`)).toBeUndefined();
        expect(segmentsOf(`C:/Windows/win.ini`)).toBeUndefined();
        expect(segmentsOf(`docs\\a.md`)).toBeUndefined();
        expect(segmentsOf(`docs/a\0.md`)).toBeUndefined();
    });
});

// What NTFS did with such names (2026-10-06): `a.txt:ads` resolved as a writable path into a hidden stream of `a.txt`,
// `a.txt::$DATA` as `a.txt` itself, and `CON` as a file PowerShell then cannot delete.
describe(`segmentsOf on Windows`, () => {
    it(`refuses a name Windows cannot hold, and keeps it on other systems`, () => {
        for (const path of [`src/a.txt:ads`, `src/a.txt::$DATA`, `CON`, `docs/nul.txt`, `src/a.txt.`, `src/a.txt `, `a|b`, `a?b`, `a*b`, `a<b>`, `q"uote`]) {
            expect(segmentsOf(path, `win32`)).toBeUndefined();
            expect(segmentsOf(path, `linux`)).toEqual(path.split(`/`));
        }
        expect(segmentsOf(`src/console.ts`, `win32`)).toEqual([`src`, `console.ts`]);
        expect(segmentsOf(`./docs/a.md`, `win32`)).toEqual([`docs`, `a.md`]);
    });
});

describe(`cleanRelPath`, () => {
    it(`is the path the grants and events speak in, the root as empty`, () => {
        expect(cleanRelPath(`/docs/a.md`)).toBe(`docs/a.md`);
        expect(cleanRelPath(`.`)).toBe(``);
        expect(cleanRelPath(`../a`)).toBeUndefined();
    });
});
