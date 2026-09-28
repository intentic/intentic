import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Grant, Grants } from "./grants.js";
import { BROKEN_LINK } from "./paths.js";
import type { LocalFilesServer } from "./server.js";
import { type Ask, askerOf, localServer, PORT } from "./testing.js";

// What a window can reach over HTTP on a real disk, beyond its folder's own files: links that lead out, a body with no
// length that would fill the disk, another window's folder, and a window the app has closed.

const MINE = `a`.repeat(64);
const THEIRS = `b`.repeat(64);
// Low, so a test can pass it without writing the real cap's quarter gigabyte.
const CAP = 64 * 1024;

let base: string;
let project: string;
let other: string;
let outside: string;
let grants: Grants;
let mine: Grant;
let server: LocalFilesServer;
let ask: (path: string, init?: Ask) => Promise<Response>;
beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), `local-files-confinement-`)));
    project = join(base, `project`);
    other = join(base, `other`);
    outside = join(base, `outside`);
    for (const folder of [project, other, outside]) {
        mkdirSync(folder);
    }
    writeFileSync(join(project, `mine.txt`), `mine`);
    writeFileSync(join(other, `theirs.txt`), `theirs`);
    // Links a folder can hold that lead out of it: to a file that does not exist yet, to a folder that does not, and to
    // a folder that does.
    symlinkSync(join(outside, `planted.txt`), join(project, `dangling.txt`));
    symlinkSync(join(outside, `made`), join(project, `dangling-dir`));
    symlinkSync(outside, join(project, `out`));
    grants = new Grants();
    mine = { token: MINE, id: `w1`, root: project, name: `project` };
    grants.add(mine);
    grants.add({ token: THEIRS, id: `w2`, root: other, name: `other` });
    server = localServer(grants, { writeCap: CAP });
    ask = askerOf(server);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const upload = (path: string, body: BodyInit, token = MINE): Promise<Response> =>
    ask(`/workspace/upload?path=${encodeURIComponent(path)}`, { method: `POST`, token, body });

// A body as a chunked upload sends it, with no Content-Length: `bytes` of `a`, in 16 KiB pieces.
const chunked = (bytes: number): ReadableStream<Uint8Array> => {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
        pull: (controller) => {
            const size = Math.min(16 * 1024, bytes - sent);
            if (size === 0) {
                controller.close();
                return;
            }
            sent += size;
            controller.enqueue(new Uint8Array(size).fill(0x61));
        },
    });
};

const uploadChunked = async (path: string, bytes: number, offset = 0): Promise<Response> => {
    const request = new Request(`http://127.0.0.1:${PORT}/workspace/upload?path=${path}&offset=${offset}`, {
        method: `POST`,
        headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${MINE}` },
        body: chunked(bytes),
    });
    // What makes it chunked: nothing declares the length the route could refuse up front.
    expect(request.headers.get(`content-length`)).toBeNull();
    return server.fetch(request, PORT);
};

describe(`a write never follows a link out of its folder`, () => {
    it(`refuses a link that points at nothing, and creates nothing where it points`, async () => {
        const answer = await upload(`dangling.txt`, `escaped`);
        expect(answer.status).toBe(400);
        expect(await answer.json()).toEqual({ error: BROKEN_LINK });
        expect(readdirSync(outside)).toEqual([]);
        expect(lstatSync(join(project, `dangling.txt`)).isSymbolicLink()).toBe(true);
    });

    it(`refuses a write below a linked folder that leads out, whether the folder or the file exists or not`, async () => {
        writeFileSync(join(outside, `existing.txt`), `kept`);
        const answers = await Promise.all([upload(`out/new.txt`, `x`), upload(`out/existing.txt`, `x`), upload(`dangling-dir/new.txt`, `x`)]);
        expect(await Promise.all(answers.map(async (answer) => [answer.status, await answer.json()]))).toEqual([
            [400, { error: `outside this folder` }],
            [400, { error: `outside this folder` }],
            [400, { error: BROKEN_LINK }],
        ]);
        expect(readdirSync(outside)).toEqual([`existing.txt`]);
        expect(readFileSync(join(outside, `existing.txt`), `utf8`)).toBe(`kept`);
    });
});

describe(`a body with no declared length is held to the cap by what it sends`, () => {
    it(`takes a first part of exactly the cap, and refuses one byte more leaving the file as it was`, async () => {
        expect((await uploadChunked(`full.bin`, CAP)).status).toBe(200);
        expect(statSync(join(project, `full.bin`)).size).toBe(CAP);
        const answer = await uploadChunked(`mine.txt`, CAP + 1);
        expect(answer.status).toBe(413);
        expect(await answer.json()).toEqual({ error: `file too large` });
        expect(readFileSync(join(project, `mine.txt`), `utf8`)).toBe(`mine`);
        // No half-written save is left beside it either.
        expect(readdirSync(project).toSorted()).toEqual([`dangling-dir`, `dangling.txt`, `full.bin`, `mine.txt`, `out`]);
    });

    it(`refuses a later part that runs past the cap before the file holds more than the cap`, async () => {
        const answer = await uploadChunked(`mine.txt`, CAP, 4);
        expect(answer.status).toBe(413);
        // How much of the part landed before the refusal depends on how the runtime cut the body; that it stopped at
        // the cap does not.
        expect(statSync(join(project, `mine.txt`)).size).toBeLessThanOrEqual(CAP);
    });
});

describe(`two windows on different folders`, () => {
    it(`each reads only its own folder`, async () => {
        const read = async (path: string, token: string): Promise<[number, unknown]> => {
            const answer = await ask(`/workspace/file?path=${encodeURIComponent(path)}`, { token });
            return [answer.status, await answer.json()];
        };
        expect(await read(`theirs.txt`, MINE)).toEqual([200, { present: false, path: `theirs.txt` }]);
        expect((await read(`../other/theirs.txt`, MINE))[0]).toBe(400);
        expect((await ask(`/workspace/raw?path=../other/theirs.txt`, { token: MINE })).status).toBe(400);
        expect((await ask(`/workspace/raw?path=theirs.txt`, { token: MINE })).status).toBe(404);
        expect(await read(`mine.txt`, THEIRS)).toEqual([200, { present: false, path: `mine.txt` }]);
        expect((await read(`theirs.txt`, THEIRS))[1]).toMatchObject({ present: true, content: `theirs` });
    });

    it(`each writes only into its own folder`, async () => {
        expect((await upload(`../other/theirs.txt`, `overwritten`)).status).toBe(400);
        expect((await upload(`theirs.txt`, `a copy of my own`)).status).toBe(200);
        expect((await upload(`mine.txt`, `written by them`, THEIRS)).status).toBe(200);
        expect(readFileSync(join(other, `theirs.txt`), `utf8`)).toBe(`theirs`);
        expect(readFileSync(join(project, `theirs.txt`), `utf8`)).toBe(`a copy of my own`);
        expect(readFileSync(join(project, `mine.txt`), `utf8`)).toBe(`mine`);
        expect(readFileSync(join(other, `mine.txt`), `utf8`)).toBe(`written by them`);
    });
});

describe(`a window the app closed`, () => {
    it(`is answered 401 for reads and writes, and the other window keeps its folder`, async () => {
        expect((await ask(`/workspace/file?path=mine.txt`, { token: MINE })).status).toBe(200);
        expect(grants.revoke(MINE)).toBe(mine);
        await server.forget(mine);
        const read = await ask(`/workspace/file?path=mine.txt`, { token: MINE });
        expect(read.status).toBe(401);
        expect(await read.json()).toEqual({ error: `this window no longer has that folder open` });
        expect((await upload(`mine.txt`, `after close`)).status).toBe(401);
        expect(readFileSync(join(project, `mine.txt`), `utf8`)).toBe(`mine`);
        expect((await ask(`/workspace/file?path=theirs.txt`, { token: THEIRS })).status).toBe(200);
    });
});
