import type { WorkspaceFile } from "@intentic/sandbox-contract";
import {
    createPeekCache,
    PEEK_FIRST_BYTES,
    PEEK_FOLDER_NAMES,
    PEEK_LINE_CHARS,
    PEEK_SPAN,
    type PeekFile,
    type PeekIo,
    peekKey,
    quickLookLines,
    peekRange,
    peekView,
    peekWantsMore,
    readPeek,
} from "./fileRefQuickLook";

// The rules a `path:line` hover reads and draws by, without a daemon: which rows the card shows, how far into a file it
// reads to find them, what it says when there is nothing to show, and what it keeps between hovers.

// `count` lines, each `line N` padded to `width` characters, newline-terminated: ASCII, so a byte is a character.
const numbered = (count: number, width = 20): string =>
    Array.from({ length: count }, (_, index) => `line ${index + 1}`.padEnd(width, `.`))
        .map((line) => `${line}\n`)
        .join(``);

// The daemon's window (workspace-files.ts readWorkspaceFileWindow), for ASCII: a read that stops short of the end is cut
// back to its last newline, and one that starts mid-line skips to the next line.
const windowOf = (path: string, text: string, offset: number, limit: number): WorkspaceFile => {
    let start = Math.min(offset, text.length);
    if (start > 0 && text[start - 1] !== `\n`) {
        const newline = text.indexOf(`\n`, start);
        start = newline === -1 ? text.length : newline + 1;
    }
    let end = Math.min(offset + limit, text.length);
    if (end < text.length) {
        const newline = text.lastIndexOf(`\n`, end - 1);
        end = newline >= start ? newline + 1 : end;
    }
    return { present: true, path, content: text.slice(start, end), size: text.length, offset: start, bytes: end - start, shared: true };
};

interface FakeTree {
    readonly files?: Record<string, string>;
    readonly folders?: Record<string, readonly string[]>;
    // A reference as written, and the path the daemon resolves it to.
    readonly resolves?: Record<string, string>;
}

// A workspace the peek reads through PeekIo, recording every read it asks for.
const fakeIo = ({ files = {}, folders = {}, resolves = {} }: FakeTree): PeekIo & { readonly reads: [string, number, number][] } => {
    const reads: [string, number, number][] = [];
    return {
        reads,
        resolve: (path) => Promise.resolve(resolves[path]),
        read: (path, offset, limit) => {
            reads.push([path, offset, limit]);
            const text = files[path];
            return Promise.resolve(text === undefined ? { present: false, path } : windowOf(path, text, offset, limit));
        },
        list: (path) => {
            const names = folders[path];
            return Promise.resolve(names === undefined ? { names: [], count: 0 } : { names, count: names.length });
        },
    };
};

const textFile = (text: string, path = `src/a.ts`): Extract<PeekFile, { kind: "text" }> => ({
    kind: `text`,
    path,
    text,
    bytes: text.length,
    size: text.length,
    done: true,
});

describe(`peekRange`, () => {
    it(`puts three lines above the named one and eight below`, () => {
        expect(peekRange(50, 200)).toEqual({ first: 47, last: 58 });
        expect(PEEK_SPAN).toBe(12);
    });

    it(`slides rather than shrinks at either end of the file, so the card keeps one height`, () => {
        expect(peekRange(1, 200)).toEqual({ first: 1, last: 12 });
        expect(peekRange(3, 200)).toEqual({ first: 1, last: 12 });
        expect(peekRange(4, 200)).toEqual({ first: 1, last: 12 });
        expect(peekRange(5, 200)).toEqual({ first: 2, last: 13 });
        expect(peekRange(198, 200)).toEqual({ first: 189, last: 200 });
        expect(peekRange(200, 200)).toEqual({ first: 189, last: 200 });
    });

    it(`shows the top of the file for a reference with no line`, () => {
        expect(peekRange(undefined, 200)).toEqual({ first: 1, last: 12 });
        expect(peekRange(undefined, 5)).toEqual({ first: 1, last: 5 });
    });

    it(`shows a short file whole, and a line past the end as the file's last lines`, () => {
        expect(peekRange(3, 5)).toEqual({ first: 1, last: 5 });
        expect(peekRange(500, 200)).toEqual({ first: 189, last: 200 });
    });

    it(`has no rows for a file with no lines`, () => {
        expect(peekRange(7, 0)).toEqual({ first: 1, last: 0 });
    });
});

describe(`quickLookLines`, () => {
    it(`does not count the empty string after a final newline as a line, and drops CRLF's carriage return`, () => {
        expect(quickLookLines(`a\nb\n`)).toEqual([`a`, `b`]);
        expect(quickLookLines(`a\r\nb`)).toEqual([`a`, `b`]);
        expect(quickLookLines(`a\n\n`)).toEqual([`a`, ``]);
        expect(quickLookLines(``)).toEqual([]);
    });
});

describe(`peekView`, () => {
    it(`marks the named line among its neighbours, with the lines above the window to colour from`, () => {
        const view = peekView(textFile(numbered(100, 6)), 40);
        expect(view).toEqual({
            kind: `lines`,
            path: `src/a.ts`,
            first: 37,
            lines: quickLookLines(numbered(100, 6)).slice(36, 48),
            lead: quickLookLines(numbered(100, 6)).slice(6, 36),
            target: 40,
            total: 100,
            past: false,
        });
    });

    it(`knows the file's length only once it was read whole`, () => {
        const text = numbered(40);
        const partial = { ...textFile(text), size: text.length * 2, done: false };
        expect(peekView(partial, 10)).toMatchObject({ kind: `lines`, first: 7, total: undefined });
    });

    it(`says a line after the end is not in the file, showing the file's end instead of marking anything`, () => {
        expect(peekView(textFile(numbered(20)), 45)).toMatchObject({ kind: `lines`, first: 9, target: undefined, total: 20, past: true });
    });

    it(`says a line beyond what was read is beyond reach, rather than claiming the file ends there`, () => {
        const text = numbered(20);
        expect(peekView({ ...textFile(text), size: text.length * 1000, done: true }, 45)).toEqual({ kind: `beyond`, path: `src/a.ts`, line: 45 });
    });

    it(`cuts a minified line rather than drawing all of it`, () => {
        const long = `x`.repeat(5000);
        const view = peekView(textFile(`${long}\n`), 1);
        expect(view.kind === `lines` ? view.lines : []).toEqual([`${`x`.repeat(PEEK_LINE_CHARS)}…`]);
    });

    it(`passes an answer with no text through as what it is`, () => {
        expect(peekView({ kind: `missing`, path: `src/gone.ts` }, 3)).toEqual({ kind: `missing`, path: `src/gone.ts` });
        expect(peekView({ kind: `folder`, path: `src`, names: [`a.ts`], count: 1 }, undefined)).toEqual({
            kind: `folder`,
            path: `src`,
            names: [`a.ts`],
            count: 1,
        });
    });
});

describe(`readPeek`, () => {
    it(`resolves the reference as written, then reads the file it means`, async () => {
        const io = fakeIo({ files: { "src/features/a.ts": numbered(30) }, resolves: { "features/a.ts": `src/features/a.ts` } });
        const file = await readPeek(io, `features/a.ts`, 12);
        expect(file).toMatchObject({ kind: `text`, path: `src/features/a.ts`, done: true });
        expect(io.reads).toEqual([[`src/features/a.ts`, 0, PEEK_FIRST_BYTES]]);
    });

    it(`reads on, each read as long as all the reads before it, until the named line and the rows under it are in hand`, async () => {
        // 100 bytes a line: the first read holds 655 lines, the second 1310, the third 2621.
        const text = numbered(3000, 99);
        const io = fakeIo({ files: { "src/big.ts": text } });
        const file = await readPeek(io, `src/big.ts`, 2000);
        expect(io.reads).toEqual([
            [`src/big.ts`, 0, 65_536],
            [`src/big.ts`, 65_500, 65_536],
            [`src/big.ts`, 131_000, 131_000],
        ]);
        const view = peekView(file, 2000);
        expect(view.kind === `lines` ? view.lines[3] : undefined).toBe(`line 2000`.padEnd(99, `.`));
    });

    it(`keeps the numbering when a line longer than a read was skipped over`, async () => {
        // The daemon starts the second read past the rest of the long first line, so the peek ends that line itself.
        const text = `${`x`.repeat(PEEK_FIRST_BYTES + 10)}\n${numbered(20)}`;
        const io = fakeIo({ files: { "dist/min.js": text } });
        const file = await readPeek(io, `dist/min.js`, 5);
        const view = peekView(file, 5);
        // The file's fifth line is the fourth of the numbered ones, the long line being its first.
        expect(view.kind === `lines` ? [view.lines[5 - view.first], view.total] : undefined).toEqual([`line 4`.padEnd(20, `.`), 21]);
    });

    it(`stops at its reach, and says the line is beyond it`, async () => {
        const text = numbered(40_000, 99);
        const io = fakeIo({ files: { "logs/huge.log": text } });
        const file = await readPeek(io, `logs/huge.log`, 39_000);
        // Six reads, each as long as all before it; a seventh would pass the reach, so the reading stops short of it.
        expect(io.reads.length).toBe(6);
        expect(file).toMatchObject({ kind: `text`, bytes: 2_096_000, done: true });
        expect(peekView(file, 39_000)).toEqual({ kind: `beyond`, path: `logs/huge.log`, line: 39_000 });
    });

    it(`stops reading when the file is gone between reads`, async () => {
        const io = fakeIo({ files: {} });
        const text = numbered(10);
        const held = { ...textFile(text), size: text.length * 10, done: false };
        expect(await readPeek(io, `src/a.ts`, 9, held)).toEqual({ ...held, done: true });
    });

    it(`carries on from what an earlier hover held rather than reading the file from the top again`, async () => {
        const text = numbered(3000, 99);
        const io = fakeIo({ files: { "src/big.ts": text } });
        const held = await readPeek(io, `src/big.ts`, 10);
        io.reads.length = 0;
        await readPeek(io, `src/big.ts`, 1000, held);
        expect(io.reads).toEqual([[`src/big.ts`, 65_500, 65_536]]);
    });

    it(`tells a missing path from a folder, which the daemon answers alike`, async () => {
        const names = [`a.ts`, `b.ts`, `c.ts`, `d.ts`, `e.ts`, `f.ts`, `g.ts`, `h.ts`];
        const io = fakeIo({ folders: { src: names } });
        expect(await readPeek(io, `src`, undefined)).toEqual({ kind: `folder`, path: `src`, names: names.slice(0, PEEK_FOLDER_NAMES), count: 8 });
        expect(await readPeek(io, `src/gone.ts`, 3)).toEqual({ kind: `missing`, path: `src/gone.ts` });
    });

    it(`reads a listing that fails as nothing there`, async () => {
        const io: PeekIo = { ...fakeIo({}), list: () => Promise.reject(new Error(`refused`)) };
        expect(await readPeek(io, `src/gone.ts`, 3)).toEqual({ kind: `missing`, path: `src/gone.ts` });
    });

    it(`says bytes are bytes: by a NUL in them, or by a name that never holds text, which it reads a byte of`, async () => {
        const io = fakeIo({ files: { "bin/tool": `ELF\0\0\0`, "img/shot.png": `\x89PNG\r\n` } });
        expect(await readPeek(io, `bin/tool`, 1)).toEqual({ kind: `binary`, path: `bin/tool`, size: 6 });
        expect(await readPeek(io, `img/shot.png`, undefined)).toEqual({ kind: `binary`, path: `img/shot.png`, size: 6 });
        expect(io.reads.at(-1)).toEqual([`img/shot.png`, 0, 1]);
    });

    it(`says an empty file is empty`, async () => {
        const io = fakeIo({ files: { "src/empty.ts": `` } });
        expect(await readPeek(io, `src/empty.ts`, 1)).toEqual({ kind: `empty`, path: `src/empty.ts` });
    });

    it(`throws a refused read, for the card to say it could not read the file`, async () => {
        const io: PeekIo = { ...fakeIo({}), read: () => Promise.reject(new Error(`403`)) };
        await expect(readPeek(io, `src/a.ts`, 1)).rejects.toThrow(`403`);
    });
});

describe(`peekWantsMore`, () => {
    it(`asks for the rows under the named line, or the top of the file's worth with no line`, () => {
        const text = numbered(20);
        const partial = { ...textFile(text), size: text.length * 2, done: false };
        expect(peekWantsMore(partial, 12)).toBe(false);
        expect(peekWantsMore(partial, 13)).toBe(true);
        expect(peekWantsMore(partial, undefined)).toBe(false);
        expect(peekWantsMore({ ...partial, text: numbered(11) }, undefined)).toBe(true);
        expect(peekWantsMore(textFile(text), 400)).toBe(false);
    });
});

describe(`createPeekCache`, () => {
    const answer = (path: string, text = numbered(5)): PeekFile => textFile(text, path);
    const always = (): boolean => true;

    it(`reads a file once however many hovers ask for it at the same time`, async () => {
        const cache = createPeekCache({ freshFor: 1000, budget: 1_000_000 });
        const read = jest.fn(() => Promise.resolve(answer(`a`)));
        const [first, second] = await Promise.all([cache.load(`a`, read, always), cache.load(`a`, read, always)]);
        expect(read).toHaveBeenCalledTimes(1);
        expect(second).toBe(first);
        expect(cache.peek(`a`)).toBe(first);
    });

    it(`reads a file again once its answer is older than it may be`, async () => {
        let now = 0;
        const cache = createPeekCache({ freshFor: 1000, budget: 1_000_000, now: () => now });
        const read = jest.fn(() => Promise.resolve(answer(`a`)));
        await cache.load(`a`, read, always);
        now = 1000;
        expect(cache.peek(`a`)).toEqual(answer(`a`));
        now = 1001;
        expect(cache.peek(`a`)).toBeUndefined();
        await cache.load(`a`, read, always);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it(`does not remember a failed read`, async () => {
        const cache = createPeekCache({ freshFor: 1000, budget: 1_000_000 });
        const read = jest.fn().mockRejectedValueOnce(new Error(`offline`)).mockResolvedValueOnce(answer(`a`));
        await expect(cache.load(`a`, read, always)).rejects.toThrow(`offline`);
        expect(cache.peek(`a`)).toBeUndefined();
        expect(await cache.load(`a`, read, always)).toEqual(answer(`a`));
        expect(read).toHaveBeenCalledTimes(2);
    });

    it(`hands a read what it held when that falls short, and chains a second ask onto a read under way`, async () => {
        const cache = createPeekCache({ freshFor: 1000, budget: 1_000_000 });
        const short = answer(`a`, numbered(5));
        const long = answer(`a`, numbered(50));
        const held: (PeekFile | undefined)[] = [];
        const read = (was: PeekFile | undefined): Promise<PeekFile> => {
            held.push(was);
            return Promise.resolve(was === undefined ? short : long);
        };
        const enough = (file: PeekFile): boolean => file.kind === `text` && quickLookLines(file.text).length >= 40;
        // The first ask needs little; the second, made while the first is reading, needs more of the same file.
        const [first, second] = await Promise.all([cache.load(`a`, read, always), cache.load(`a`, read, enough)]);
        expect([first, second]).toEqual([short, long]);
        expect(held).toEqual([undefined, short]);
        expect(cache.peek(`a`)).toBe(long);
    });

    it(`lets the least recently shown file go first when the text held passes its budget`, async () => {
        const cache = createPeekCache({ freshFor: 1000, budget: 250 });
        const hundred = numbered(5, 19);
        for (const key of [`a`, `b`]) {
            await cache.load(key, () => Promise.resolve(answer(key, hundred)), always);
        }
        cache.peek(`a`);
        await cache.load(`c`, () => Promise.resolve(answer(`c`, hundred)), always);
        expect([cache.peek(`a`) !== undefined, cache.peek(`b`) !== undefined, cache.peek(`c`) !== undefined]).toEqual([true, false, true]);
    });

    it(`keeps the file just read even when it alone is over the budget`, async () => {
        const cache = createPeekCache({ freshFor: 1000, budget: 10 });
        await cache.load(`a`, () => Promise.resolve(answer(`a`, numbered(50))), always);
        expect(cache.peek(`a`)).toEqual(answer(`a`, numbered(50)));
    });
});

describe(`peekKey`, () => {
    it(`keeps a conversation's checkout apart from the shared tree`, () => {
        expect(peekKey(`src/a.ts`, `agent-1`)).not.toBe(peekKey(`src/a.ts`, undefined));
        expect(peekKey(`src/a.ts`, undefined)).toBe(`\u0000src/a.ts`);
    });
});
