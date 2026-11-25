import { closeSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, ftruncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Grants } from "../grants.js";
import { rangeOf } from "../media.js";
import { APP, type Ask, askerOf, localServer } from "../testing.js";

// A folder's big files, as a window reads them: any size through /workspace/raw, and a recording streamed in the ranges
// a player asks for, on a ticket its address carries in place of the window's bearer.

const TOKEN = `f`.repeat(64);
// Past the 25 MiB the raw read once refused: a scanned book, a film.
const LARGE = 30 * 1024 * 1024;
const CLIP = Buffer.from(`0123456789abcdef`);

let dir: string;
let outside: string;
let grants: Grants;
let ask: (path: string, init?: Ask) => Promise<Response>;
beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), `local-files-media-`)));
    outside = realpathSync(mkdtempSync(join(tmpdir(), `local-files-media-outside-`)));
    writeFileSync(join(dir, `clip.mp4`), CLIP);
    writeFileSync(join(dir, `notes.txt`), `notes`);
    writeFileSync(join(outside, `secret.mp4`), `secret`);
    // Sparse, so the suite writes no 30 MB to disk.
    const handle = openSync(join(dir, `book.pdf`), `w`);
    ftruncateSync(handle, LARGE);
    closeSync(handle);
    grants = new Grants();
    grants.add({ token: TOKEN, id: `w1`, root: dir, name: `project` });
    ask = askerOf(localServer(grants));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
});

const ticketFor = async (path: string, token = TOKEN): Promise<Response> =>
    ask(`/workspace/media-ticket`, { method: `POST`, token, origin: APP, body: JSON.stringify({ path }), headers: { "content-type": `application/json` } });

const minted = async (path: string): Promise<string> => {
    const answer = await ticketFor(path);
    expect(answer.status).toBe(200);
    // SAFETY: the contract's WorkspaceMediaTicket, of which only the ticket is read; a missing one fails the URL below.
    return ((await answer.json()) as { ticket: string }).ticket;
};

// A player's read: no bearer, and no Origin, which a media element does not send.
const play = (path: string, ticket: string, init: Ask = {}): Promise<Response> =>
    ask(`/workspace/media?${new URLSearchParams({ path, ticket }).toString()}`, init);

describe(`a large file`, () => {
    it(`streams through the raw read at any size, saying its full length`, async () => {
        const read = await ask(`/workspace/raw?path=book.pdf`, { token: TOKEN, origin: APP });
        expect(read.status).toBe(200);
        expect(read.headers.get(`content-type`)).toBe(`application/pdf`);
        expect(read.headers.get(`content-length`)).toBe(String(LARGE));
        await read.body?.cancel();
    });
});

describe(`a recording streamed to its window's player`, () => {
    it(`answers the whole file, then the ranges the player asks for`, async () => {
        const ticket = await minted(`clip.mp4`);
        const whole = await play(`clip.mp4`, ticket);
        expect(whole.status).toBe(200);
        expect(whole.headers.get(`content-type`)).toBe(`video/mp4`);
        expect(whole.headers.get(`accept-ranges`)).toBe(`bytes`);
        expect(Buffer.from(await whole.arrayBuffer())).toEqual(CLIP);

        const part = await play(`clip.mp4`, ticket, { headers: { range: `bytes=2-5` } });
        expect(part.status).toBe(206);
        expect(part.headers.get(`content-range`)).toBe(`bytes 2-5/16`);
        expect(await part.text()).toBe(`2345`);

        const tail = await play(`clip.mp4`, ticket, { headers: { range: `bytes=-3` } });
        expect([tail.status, await tail.text()]).toEqual([206, `def`]);

        const past = await play(`clip.mp4`, ticket, { headers: { range: `bytes=99-` } });
        expect([past.status, past.headers.get(`content-range`)]).toEqual([416, `bytes */16`]);
    });

    it(`streams a large one in ranges, never whole`, async () => {
        const part = await play(`book.pdf`, await minted(`book.pdf`), { headers: { range: `bytes=0-1023` } });
        expect(part.status).toBe(206);
        expect(part.headers.get(`content-range`)).toBe(`bytes 0-1023/${String(LARGE)}`);
        expect((await part.arrayBuffer()).byteLength).toBe(1024);
    });

    it(`saves the file under its own name when asked to download it`, async () => {
        const saved = await ask(`/workspace/media?${new URLSearchParams({ path: `clip.mp4`, ticket: await minted(`clip.mp4`), download: `1` }).toString()}`);
        expect(saved.headers.get(`content-disposition`)).toBe(`attachment; filename*=UTF-8''clip.mp4`);
        await saved.body?.cancel();
    });

    it(`opens only the file its ticket was minted for`, async () => {
        const ticket = await minted(`clip.mp4`);
        expect((await play(`notes.txt`, ticket)).status).toBe(404);
        expect((await play(`clip.mp4`, `x`.repeat(43))).status).toBe(401);
        expect((await play(`clip.mp4`, ``)).status).toBe(401);
    });

    it(`mints nothing for a path outside the folder, or for a window it never granted`, async () => {
        expect((await ticketFor(`../secret.mp4`)).status).toBe(400);
        expect((await ticketFor(`missing.mp4`)).status).toBe(404);
        expect((await ticketFor(`clip.mp4`, `x`.repeat(64))).status).toBe(401);
    });

    it(`stops opening the file once a link is put in its place that leads out of the folder`, async () => {
        const ticket = await minted(`clip.mp4`);
        unlinkSync(join(dir, `clip.mp4`));
        symlinkSync(join(outside, `secret.mp4`), join(dir, `clip.mp4`));
        expect((await play(`clip.mp4`, ticket)).status).not.toBe(200);
    });

    it(`is refused to another site's page, and once the window's grant has ended`, async () => {
        const ticket = await minted(`clip.mp4`);
        expect((await play(`clip.mp4`, ticket, { origin: `https://evil.example` })).status).toBe(403);
        expect((await play(`clip.mp4`, ticket, { origin: APP })).status).toBe(200);
        grants.revoke(TOKEN);
        expect((await play(`clip.mp4`, ticket)).status).toBe(401);
    });
});

describe(`rangeOf`, () => {
    it(`reads one range, a suffix, an open end, and refuses what lies past the file`, () => {
        expect(rangeOf(null, 10)).toEqual({ start: 0, end: 9, partial: false });
        expect(rangeOf(`bytes=0-0,5-6`, 10)).toEqual({ start: 0, end: 9, partial: false });
        expect(rangeOf(`bytes=4-`, 10)).toEqual({ start: 4, end: 9, partial: true });
        expect(rangeOf(`bytes=4-400`, 10)).toEqual({ start: 4, end: 9, partial: true });
        expect(rangeOf(`bytes=-4`, 10)).toEqual({ start: 6, end: 9, partial: true });
        expect(rangeOf(`bytes=-40`, 10)).toEqual({ start: 0, end: 9, partial: true });
        expect(rangeOf(`bytes=10-`, 10)).toBe(`unsatisfiable`);
        expect(rangeOf(`bytes=5-4`, 10)).toBe(`unsatisfiable`);
        expect(rangeOf(`bytes=-0`, 10)).toBe(`unsatisfiable`);
        expect(rangeOf(`bytes=0-`, 0)).toBe(`unsatisfiable`);
    });
});
