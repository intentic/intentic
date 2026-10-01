import { chunked, tarOf, type TarFixtureEntry } from "../../testing.js";
import { paxRecords, readTar, type TarEntry } from "../tar.js";

// The tar reader against archives written the ways `git archive` and other tars write them, fed in chunks that fall
// anywhere: one byte at a time, 7 at a time, and all at once.

interface Read {
    readonly entry: TarEntry;
    readonly body: string | undefined;
}

// Every entry, with the body of each file read whole; `skip` names entries whose bodies are left unread.
const readAll = async (archive: Buffer, chunk: number, skip: readonly string[] = []): Promise<Read[]> => {
    const seen: Read[] = [];
    await readTar(chunked(archive, chunk), async (entry, body) => {
        if (entry.type !== `file` || skip.includes(entry.name)) {
            seen.push({ entry, body: undefined });
            return;
        }
        const parts: Buffer[] = [];
        for await (const part of body) {
            parts.push(part);
        }
        seen.push({ entry, body: Buffer.concat(parts).toString(`utf8`) });
    });
    return seen;
};

const longPath = `document-0123/public/web-apps/apps/documenteditor/main/resources/img/toolbar/1.25x/big/btn-insert-equation.png`;

const entries: TarFixtureEntry[] = [
    { name: `document-0123/`, type: `directory` },
    { name: `document-0123/NOTICE`, body: `notice text` },
    { name: `document-0123/empty.json`, body: `` },
    { name: longPath, body: `pax-named`, longName: `pax-name` },
    { name: `${longPath}.gnu`, body: `gnu-named`, longName: `gnu-name` },
    { name: `${longPath}.prefix`, body: `prefix-named`, longName: `prefix` },
    { name: `document-0123/link`, type: `symlink` },
    // A body spanning several blocks, not a multiple of the block size.
    { name: `document-0123/big.bin`, body: `x`.repeat(1300) },
];

describe(`reading an archive`, () => {
    for (const chunk of [1, 7, 512, 1 << 20]) {
        it(`hands over every entry with its whole body, in order, fed ${chunk} bytes at a time`, async () => {
            expect(await readAll(tarOf(entries), chunk)).toEqual([
                { entry: { name: `document-0123/`, type: `directory`, size: 0 }, body: undefined },
                { entry: { name: `document-0123/NOTICE`, type: `file`, size: 11 }, body: `notice text` },
                { entry: { name: `document-0123/empty.json`, type: `file`, size: 0 }, body: `` },
                { entry: { name: longPath, type: `file`, size: 9 }, body: `pax-named` },
                { entry: { name: `${longPath}.gnu`, type: `file`, size: 9 }, body: `gnu-named` },
                { entry: { name: `${longPath}.prefix`, type: `file`, size: 12 }, body: `prefix-named` },
                { entry: { name: `document-0123/link`, type: `other`, size: 0 }, body: undefined },
                { entry: { name: `document-0123/big.bin`, type: `file`, size: 1300 }, body: `x`.repeat(1300) },
            ]);
        });
    }

    it(`skips what a handler leaves unread and what it stops reading partway, and stays on the next header`, async () => {
        const archive = tarOf([
            { name: `a/one`, body: `1`.repeat(700) },
            { name: `a/two`, body: `2`.repeat(900) },
            { name: `a/three`, body: `three` },
        ]);
        const bodies: string[] = [];
        // Block-sized chunks, so the part the handler stops after is exactly the first block of `a/two`.
        await readTar(chunked(archive, 512), async (entry, body) => {
            if (entry.name === `a/one`) {
                return;
            }
            for await (const part of body) {
                bodies.push(`${entry.name}:${part.toString(`utf8`)}`);
                if (entry.name === `a/two`) {
                    break;
                }
            }
        });
        expect(bodies).toEqual([`a/two:${`2`.repeat(512)}`, `a/three:three`]);
    });

    it(`ends cleanly at the end marker, and at a stream that simply stops between entries`, async () => {
        const archive = tarOf([{ name: `a/one`, body: `1` }]);
        expect(await readAll(archive.subarray(0, 1024), 64)).toEqual([{ entry: { name: `a/one`, type: `file`, size: 1 }, body: `1` }]);
    });
});

describe(`refusing a damaged archive`, () => {
    it(`throws on an archive cut off inside an entry`, async () => {
        const archive = tarOf([{ name: `a/one`, body: `1`.repeat(700) }]);
        await expect(readAll(archive.subarray(0, 900), 64)).rejects.toThrow(`the archive ends in the middle of an entry`);
    });

    it(`throws on a header whose checksum does not add up`, async () => {
        const archive = tarOf([{ name: `a/one`, body: `1` }]);
        archive[0] = `b`.charCodeAt(0);
        await expect(readAll(archive, 512)).rejects.toThrow(`the archive has a header whose checksum does not match`);
    });
});

describe(`pax records`, () => {
    it(`reads each record by its own length, values that contain "=" and newlines included`, () => {
        const body = Buffer.from(`30 path=a/b=c/d e.txt\nnewline\n11 size=42\n`);
        expect(Object.fromEntries(paxRecords(body))).toEqual({ path: `a/b=c/d e.txt\nnewline`, size: `42` });
    });
});
