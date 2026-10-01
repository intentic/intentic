import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP_MS, Originals } from "../originals.js";

// A document's original, kept in a cache dir apart from it before the first overwrite: what is kept and when, how a
// restore puts it back and can itself be taken back, and what a week's sweep leaves.

const T0 = Date.parse(`2026-09-01T10:00:00.000Z`);

let dir: string;
let cache: string;
let doc: string;
let now: number;
let originals: Originals;
beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), `oo-originals-`)));
    cache = join(dir, `cache`, `office-originals`);
    await mkdir(join(dir, `work`));
    doc = join(dir, `work`, `brief.docx`);
    await writeFile(doc, `as it came`);
    now = T0;
    originals = new Originals({ dir: cache, log: () => undefined, now: () => now });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

// The one folder a document's originals are kept in, and what it holds.
const keptFiles = async (): Promise<string[]> => {
    const [folder] = await readdir(cache);
    return (await readdir(join(cache, folder ?? ``))).toSorted();
};

describe(`keeping`, () => {
    it(`keeps the document as it was before the first overwrite only, and says since when`, async () => {
        expect(await originals.original(doc)).toEqual({ kept: false });
        await originals.beforeOverwrite(doc);
        await writeFile(doc, `first save`);
        now = T0 + 60_000;
        await originals.beforeOverwrite(doc);
        await writeFile(doc, `second save`);
        expect(await originals.original(doc)).toEqual({ kept: true, keptAt: `2026-09-01T10:00:00.000Z` });
        // Named so any file system takes it: no colons.
        expect(await keptFiles()).toEqual([`2026-09-01T10-00-00.000Z-brief.docx`, `meta.json`]);
        const [folder] = await readdir(cache);
        expect(await readFile(join(cache, folder ?? ``, `2026-09-01T10-00-00.000Z-brief.docx`), `utf8`)).toBe(`as it came`);
        expect(JSON.parse(await readFile(join(cache, folder ?? ``, `meta.json`), `utf8`))).toEqual({
            path: doc,
            name: `brief.docx`,
            keptAt: `2026-09-01T10:00:00.000Z`,
        });
    });

    // A later run's first save keeps how the document stood when that run began.
    it(`keeps again in the next run of the app`, async () => {
        await originals.beforeOverwrite(doc);
        await writeFile(doc, `first run's edit`);
        now = T0 + 60_000;
        await new Originals({ dir: cache, log: () => undefined, now: () => now }).beforeOverwrite(doc);
        expect(await originals.original(doc)).toEqual({ kept: true, keptAt: `2026-09-01T10:01:00.000Z` });
    });
});

describe(`restoring`, () => {
    it(`puts the original back, and keeps what it replaced so a second restore undoes the first`, async () => {
        await originals.beforeOverwrite(doc);
        await writeFile(doc, `edited`);
        now = T0 + 60_000;
        expect(await originals.restore(doc)).toBe(true);
        expect(await readFile(doc, `utf8`)).toBe(`as it came`);
        expect(await originals.original(doc)).toEqual({ kept: true, keptAt: `2026-09-01T10:01:00.000Z` });
        now = T0 + 120_000;
        expect(await originals.restore(doc)).toBe(true);
        expect(await readFile(doc, `utf8`)).toBe(`edited`);
        // Nothing is left beside the document: the bytes came back through a scratch name and a rename.
        expect(await readdir(join(dir, `work`))).toEqual([`brief.docx`]);
    });

    // Windows refuses to replace a document another program holds open: the original must still be there to try again.
    it(`leaves the document and its original as they were when putting it back fails, and restores on the next try`, async () => {
        let busy = true;
        const held = new Originals({
            dir: cache,
            log: () => undefined,
            now: () => now,
            replace: async (from, to) => {
                if (busy) {
                    throw Object.assign(new Error(`EBUSY: resource busy or locked, rename`), { code: `EBUSY` });
                }
                await rename(from, to);
            },
        });
        await held.beforeOverwrite(doc);
        await writeFile(doc, `edited`);
        now = T0 + 60_000;
        await expect(held.restore(doc)).rejects.toMatchObject({ code: `EBUSY` });
        expect(await readFile(doc, `utf8`)).toBe(`edited`);
        expect(await held.original(doc)).toEqual({ kept: true, keptAt: `2026-09-01T10:00:00.000Z` });
        expect(await keptFiles()).toEqual([`2026-09-01T10-00-00.000Z-brief.docx`, `meta.json`]);
        expect(await readdir(join(dir, `work`))).toEqual([`brief.docx`]);
        busy = false;
        now = T0 + 120_000;
        expect(await held.restore(doc)).toBe(true);
        expect(await readFile(doc, `utf8`)).toBe(`as it came`);
        expect(await held.original(doc)).toEqual({ kept: true, keptAt: `2026-09-01T10:02:00.000Z` });
    });

    it(`answers that there is nothing to restore when nothing was kept`, async () => {
        expect(await originals.restore(doc)).toBe(false);
        expect(await readFile(doc, `utf8`)).toBe(`as it came`);
    });
});

describe(`sweeping`, () => {
    it(`removes what was kept more than a week ago, and nothing newer`, async () => {
        const other = join(dir, `work`, `plan.xlsx`);
        await writeFile(other, `plan`);
        await originals.beforeOverwrite(doc);
        now = T0 + KEEP_MS - 1_000;
        await originals.beforeOverwrite(other);
        now = T0 + KEEP_MS + 1_000;
        await originals.sweep();
        expect([await originals.original(doc), await originals.original(other)]).toEqual([
            { kept: false },
            { kept: true, keptAt: new Date(T0 + KEEP_MS - 1_000).toISOString() },
        ]);
        expect(await readdir(cache)).toHaveLength(1);
    });

    // A document kept in two runs holds two copies; the older one goes once it is a week old.
    it(`removes a document's older copies past a week, keeping the one its meta.json names`, async () => {
        await originals.beforeOverwrite(doc);
        now = T0 + KEEP_MS - 1_000;
        await new Originals({ dir: cache, log: () => undefined, now: () => now }).beforeOverwrite(doc);
        now = T0 + KEEP_MS + 1_000;
        await originals.sweep();
        expect(await keptFiles()).toEqual([`${new Date(T0 + KEEP_MS - 1_000).toISOString().replaceAll(`:`, `-`)}-brief.docx`, `meta.json`]);
    });
});
