import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFile, readWindow, sha256Text, writeFileWhole, writePartAt } from "./files.js";

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

// A body as a request carries it, `bytes` of `a` in 1 KiB pieces.
const bodyOf = (bytes: number): ReadableStream<Uint8Array> => {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
        pull: (controller) => {
            const size = Math.min(1024, bytes - sent);
            if (size === 0) {
                controller.close();
                return;
            }
            sent += size;
            controller.enqueue(new Uint8Array(size).fill(0x61));
        },
    });
};

describe(`writing never follows a link`, () => {
    // The save lands by rename, which replaces the link itself: whatever it pointed at is never opened.
    it(`replaces a link at the file with the saved file, and leaves what it pointed at alone`, async () => {
        mkdirSync(join(dir, `elsewhere`));
        writeFileSync(join(dir, `elsewhere`, `target.txt`), `untouched`);
        symlinkSync(join(dir, `elsewhere`, `target.txt`), join(dir, `live.txt`));
        symlinkSync(join(dir, `elsewhere`, `planted.txt`), join(dir, `dangling.txt`));
        expect(await writeFileWhole(join(dir, `live.txt`), new TextEncoder().encode(`saved`), undefined)).toBeUndefined();
        expect(await writeFileWhole(join(dir, `dangling.txt`), new TextEncoder().encode(`saved`), undefined)).toBeUndefined();
        expect([lstatSync(join(dir, `live.txt`)).isFile(), readFileSync(join(dir, `live.txt`), `utf8`)]).toEqual([true, `saved`]);
        expect(lstatSync(join(dir, `dangling.txt`)).isFile()).toBe(true);
        expect(readFileSync(join(dir, `elsewhere`, `target.txt`), `utf8`)).toBe(`untouched`);
        expect(readdirSync(join(dir, `elsewhere`))).toEqual([`target.txt`]);
    });

    it(`refuses a later part at a link, dangling or not, and writes nothing through it`, async () => {
        writeFileSync(join(dir, `target.txt`), `untouched`);
        symlinkSync(join(dir, `target.txt`), join(dir, `live.txt`));
        symlinkSync(join(dir, `planted.txt`), join(dir, `dangling.txt`));
        expect(await writePartAt(join(dir, `live.txt`), bodyOf(4), 2)).toBe(`changed`);
        expect(await writePartAt(join(dir, `dangling.txt`), bodyOf(4), 2)).toBe(`changed`);
        expect(readFileSync(join(dir, `target.txt`), `utf8`)).toBe(`untouched`);
        expect(readdirSync(dir).toSorted()).toEqual([`dangling.txt`, `live.txt`, `target.txt`]);
    });
});

describe(`the cap`, () => {
    it(`holds a streamed save to the cap by what arrives, leaving the file as it was`, async () => {
        writeFileSync(join(dir, `a.md`), `old`);
        expect(await writeFileWhole(join(dir, `a.md`), bodyOf(4096), undefined, 4096)).toBeUndefined();
        expect(statSync(join(dir, `a.md`)).size).toBe(4096);
        expect(await writeFileWhole(join(dir, `a.md`), bodyOf(4097), undefined, 4096)).toBe(`too-large`);
        expect(statSync(join(dir, `a.md`)).size).toBe(4096);
        expect(readdirSync(dir)).toEqual([`a.md`]);
    });

    // 3 KiB are on disk, so the part may add 1 KiB: its first piece fits, and its second is refused before it lands.
    it(`holds a later part to what the cap leaves after its offset`, async () => {
        writeFileSync(join(dir, `drop.bin`), new Uint8Array(3072));
        expect(await writePartAt(join(dir, `drop.bin`), bodyOf(2048), 3072, 4096)).toBe(`too-large`);
        expect(statSync(join(dir, `drop.bin`)).size).toBe(4096);
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
