import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFile, readWindow, sha256Text, writeFileWhole } from "./files.js";

let dir: string;
beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), `local-files-files-`)));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe(`readWindow`, () => {
    it(`reads a small file whole, and says nothing for a missing one or a folder`, async () => {
        writeFileSync(join(dir, `a.md`), `# a\nbody\n`);
        expect(await readWindow(join(dir, `a.md`))).toEqual({ content: `# a\nbody\n`, size: 9, offset: 0, bytes: 9 });
        expect(await readWindow(join(dir, `missing.md`))).toBeUndefined();
        expect(await readWindow(dir)).toBeUndefined();
    });

    // A window never starts or ends inside a character or a line it cut, or the editor shows garbage at the seam.
    it(`cuts a window on whole lines, and a character is never split`, async () => {
        writeFileSync(join(dir, `log.txt`), `one\ntwo\nthree\n`);
        expect(await readWindow(join(dir, `log.txt`), 2, 7)).toEqual({ content: `two\n`, size: 14, offset: 4, bytes: 4 });
        writeFileSync(join(dir, `zl.txt`), `żółw`);
        expect(await readWindow(join(dir, `zl.txt`), 0, 2)).toEqual({ content: `ż`, size: 7, offset: 0, bytes: 2 });
        expect(await readWindow(join(dir, `zl.txt`), 0, 3)).toEqual({ content: `ż`, size: 7, offset: 0, bytes: 2 });
    });
});

describe(`writeFileWhole`, () => {
    it(`replaces the file when it still holds the text the save was based on`, async () => {
        writeFileSync(join(dir, `a.md`), `old`);
        expect(await writeFileWhole(join(dir, `a.md`), new TextEncoder().encode(`new`), sha256Text(`old`))).toBeUndefined();
        expect(readFileSync(join(dir, `a.md`), `utf8`)).toBe(`new`);
    });

    it(`refuses a save based on text the file no longer holds, and leaves the file as it is`, async () => {
        writeFileSync(join(dir, `a.md`), `changed by another program`);
        expect(await writeFileWhole(join(dir, `a.md`), new TextEncoder().encode(`mine`), sha256Text(`old`))).toBe(`changed`);
        expect(readFileSync(join(dir, `a.md`), `utf8`)).toBe(`changed by another program`);
    });

    // A save of a script must not quietly make it unrunnable.
    it(`keeps the replaced file's permissions`, async () => {
        writeFileSync(join(dir, `run.sh`), `echo old`);
        chmodSync(join(dir, `run.sh`), 0o755);
        expect(await writeFileWhole(join(dir, `run.sh`), new TextEncoder().encode(`echo new`), undefined)).toBeUndefined();
        expect(statSync(join(dir, `run.sh`)).mode & 0o777).toBe(0o755);
    });
});

describe(`openFile`, () => {
    it(`gives a validator that moves when the bytes do`, async () => {
        writeFileSync(join(dir, `a.bin`), `one`);
        const first = await openFile(join(dir, `a.bin`));
        writeFileSync(join(dir, `a.bin`), `other bytes`);
        const second = await openFile(join(dir, `a.bin`));
        expect(first?.size).toBe(3);
        expect(second?.size).toBe(11);
        expect(first?.tag).not.toBe(second?.tag);
        expect(await openFile(join(dir, `missing.bin`))).toBeUndefined();
    });
});
