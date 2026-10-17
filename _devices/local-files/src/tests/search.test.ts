import { placeOf } from "../ripgrep.js";
import { charSpans, printedPath } from "../search-rg.js";
import { nestsQuantifiers } from "../search-read.js";

// Which patterns the search refuses to run: a repeated group that itself repeats, read the way the engine reads it.

describe(`nestsQuantifiers`, () => {
    it(`finds a repeated group whose body repeats, however deep`, () => {
        expect([`(a+)+$`, `(\\w*\\s?)*`, `(x{2,})+`, `((ab)+c)*`, `(?:a*b)+`, `(a+?)+`].map(nestsQuantifiers)).toEqual([
            true,
            true,
            true,
            true,
            true,
            true,
        ]);
    });

    it(`passes a pattern that repeats only once at each depth`, () => {
        expect([`a+b+`, `(ab)+`, `(a+)?`, `(a+b)`, `[(+]+`, `\\(a+\\)+`, `\\w+@\\w+\\.com`, `(a|b){2}`].map(nestsQuantifiers)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
        ]);
    });
});

describe(`placeOf`, () => {
    // Windows reaches a distro's files through a share; the search runs inside the distro, at its own path.
    it(`reads a WSL share as its distro and the path inside it`, () => {
        expect(placeOf(`\\\\wsl.localhost\\archlinux\\home\\me\\repo`, `win32`)).toEqual({ kind: `wsl`, distro: `archlinux`, path: `/home/me/repo` });
        expect(placeOf(`\\\\wsl$\\Ubuntu-24.04\\srv\\app\\`, `win32`)).toEqual({ kind: `wsl`, distro: `Ubuntu-24.04`, path: `/srv/app` });
        expect(placeOf(`\\\\?\\UNC\\WSL.LOCALHOST\\arch\\`, `win32`)).toEqual({ kind: `wsl`, distro: `arch`, path: `/` });
        expect(placeOf(`//wsl.localhost/arch/home`, `win32`)).toEqual({ kind: `wsl`, distro: `arch`, path: `/home` });
    });

    it(`leaves every other folder to this computer's own search`, () => {
        expect(placeOf(`C:\\Users\\me\\repo`, `win32`)).toEqual({ kind: `native` });
        expect(placeOf(`\\\\server\\share\\repo`, `win32`)).toEqual({ kind: `native` });
        expect(placeOf(`\\\\wsl.localhost\\arch\\home`, `linux`)).toEqual({ kind: `native` });
    });
});

describe(`charSpans`, () => {
    // rg counts bytes; a page slices characters.
    it(`turns rg's byte offsets into character offsets`, () => {
        expect(charSpans(`Crème brûlée`, [{ start: 7, end: 15 }])).toEqual([{ start: 6, end: 12 }]);
        expect(charSpans(`a😀b`, [{ start: 5, end: 6 }])).toEqual([{ start: 3, end: 4 }]);
        expect(charSpans(`abc`, [{ start: 1, end: 9 }])).toEqual([{ start: 1, end: 3 }]);
    });
});

describe(`printedPath`, () => {
    // rg.exe's JSON keeps Windows' own separator, whatever --path-separator asks.
    it(`speaks every path rg prints with forward slashes, relative to the folder`, () => {
        expect(printedPath(`./_apps\\web\\src\\main.ts`, `win32`)).toBe(`_apps/web/src/main.ts`);
        expect(printedPath(`./src/app.ts`, `win32`)).toBe(`src/app.ts`);
        // Elsewhere a backslash is a character a name may hold.
        expect(printedPath(`./odd\\name.txt`, `linux`)).toBe(`odd\\name.txt`);
    });
});
