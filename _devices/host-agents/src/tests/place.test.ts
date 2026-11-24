import { findOnPath, parseEnvironment, placeKey } from "../place.js";

// The two readings a place is built on: the environment a login shell printed, and where a program is on a PATH.

describe(`parseEnvironment`, () => {
    it(`reads the variables printed after the mark, whatever the shell's profile said before it`, () => {
        const said = `Welcome back!\nfortune: be kind\n__INTENTIC_ENV__PATH=/home/ada/.local/bin:/usr/bin\0HOME=/home/ada\0NOTE=a=b\nsecond line\0`;
        expect(parseEnvironment(said)).toEqual({ PATH: `/home/ada/.local/bin:/usr/bin`, HOME: `/home/ada`, NOTE: `a=b\nsecond line` });
    });

    it(`answers nothing for a shell that never got as far as the mark`, () => {
        expect(parseEnvironment(`zsh: command not found: env`)).toBeUndefined();
        expect(parseEnvironment(`__INTENTIC_ENV__`)).toBeUndefined();
    });
});

describe(`findOnPath`, () => {
    const there =
        (...files: string[]) =>
        (file: string): boolean =>
            files.includes(file.replaceAll(`\\`, `/`));

    it(`finds a program in the first folder of the PATH that holds it`, () => {
        expect(findOnPath(`node`, `/usr/local/bin:/usr/bin`, `linux`, there(`/usr/bin/node`, `/opt/node`))?.replaceAll(`\\`, `/`)).toBe(`/usr/bin/node`);
        expect(findOnPath(`codex-acp`, `/usr/local/bin::/usr/bin`, `linux`, there())).toBeUndefined();
    });

    it(`tries Windows' own extensions for a program named without one`, () => {
        const found = findOnPath(`npm`, `C:/Tools;C:/Node`, `win32`, there(`C:/Node/npm.cmd`));
        expect(found?.replaceAll(`\\`, `/`)).toBe(`C:/Node/npm.cmd`);
        expect(findOnPath(`node.exe`, `C:/Node`, `win32`, there(`C:/Node/node.exe`))?.replaceAll(`\\`, `/`)).toBe(`C:/Node/node.exe`);
    });
});

describe(`placeKey`, () => {
    it(`names this computer's own side, and a distro whatever case it was written in`, () => {
        expect(placeKey({ kind: `native` })).toBe(`native`);
        expect(placeKey({ kind: `wsl`, distro: `ArchLinux`, path: `/home/ada/app` })).toBe(`wsl:archlinux`);
    });
});
