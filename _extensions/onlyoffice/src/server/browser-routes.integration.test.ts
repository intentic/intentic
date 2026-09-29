import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createBrowserRoutes, versionOf, type FileWrite, type FileWritten } from "./browser-routes.js";
import { Sessions, type Session } from "./sessions.js";

// The browser engine's routes over real HTTP, with the file reads and writes scripted: who may read and write the
// document, what a save must say about the version it replaces, and which static trees answer under which ids.

const LIMIT = 64;

let dir: string;
let server: http.Server;
let port = 0;
const sessions = new Sessions();
const writes: { path: string; body: string; write: FileWrite }[] = [];
// What the next write answers.
let answer: FileWritten = { written: true, path: `brief.docx`, version: `20-200` };
let bundleReady = true;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), `oo-routes-`));
    await mkdir(join(dir, `bundle`, `web-apps`), { recursive: true });
    await writeFile(join(dir, `bundle`, `web-apps`, `api.js`), `api`);
    await mkdir(join(dir, `page`), { recursive: true });
    await writeFile(join(dir, `page`, `editor.js`), `page`);
    const routes = createBrowserRoutes(
        {
            sessions,
            bundle: () => (bundleReady ? { id: `pin-1`, root: { dir: join(dir, `bundle`), gzipCache: undefined } } : undefined),
            page: () => ({ id: `abc123`, root: { dir: join(dir, `page`), gzipCache: undefined } }),
            openFile: async (session) =>
                session.path === `gone.docx`
                    ? undefined
                    : { stream: Readable.from([Buffer.from(`bytes of ${session.path}`)]), version: session.agent === undefined ? `10-100` : undefined },
            writeFile: async (session, body, write) => {
                const chunks: Buffer[] = [];
                for await (const chunk of body) {
                    // SAFETY: the request body streams Buffers.
                    chunks.push(chunk as Buffer);
                }
                writes.push({ path: session.path, body: Buffer.concat(chunks).toString(`utf8`), write });
                return answer;
            },
            log: () => undefined,
        },
        LIMIT,
    );
    server = http.createServer((req, res) => {
        const url = new URL(req.url ?? `/`, `http://routes`);
        routes(req, res, url)
            .then((handled) => {
                if (!handled) {
                    res.writeHead(418);
                    res.end(`not a browser route`);
                }
            })
            .catch(() => res.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, `127.0.0.1`, resolve));
    const address = server.address();
    port = typeof address === `object` && address !== null ? address.port : 0;
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
    writes.length = 0;
    answer = { written: true, path: `brief.docx`, version: `20-200` };
    bundleReady = true;
});

const call = (path: string, init?: RequestInit): Promise<Response> => fetch(`http://127.0.0.1:${port}${path}`, init);

const opened = (overrides: { path?: string; agent?: string; mode?: `edit` | `view`; engine?: `browser` | `server` } = {}): Session =>
    sessions.open({
        path: overrides.path ?? `brief.docx`,
        agent: overrides.agent,
        mode: overrides.mode ?? `edit`,
        theme: `light`,
        stat: { size: 10, mtimeMs: 100 },
        engine: overrides.engine ?? `browser`,
    });

const put = (session: Session, body: string, headers: Record<string, string> = {}, query = ``): Promise<Response> =>
    call(`/file?s=${session.token}${query}`, { method: `PUT`, body, headers });

describe(`reading the document`, () => {
    it(`streams a browser session's file with its version as the ETag`, async () => {
        const answered = await call(`/file?s=${opened().token}`);
        expect(answered.status).toBe(200);
        expect(answered.headers.get(`etag`)).toBe(`"10-100"`);
        expect(answered.headers.get(`cache-control`)).toBe(`no-store`);
        expect(await answered.text()).toBe(`bytes of brief.docx`);
    });

    it(`answers only a live browser-engine session`, async () => {
        expect((await call(`/file?s=${opened({ engine: `server` }).token}`)).status).toBe(404);
        expect((await call(`/file?s=nope`)).status).toBe(404);
        expect((await call(`/file?s=${opened({ path: `gone.docx` }).token}`)).status).toBe(404);
    });
});

describe(`saving the document`, () => {
    it(`writes a save that names the version it replaces, and answers the new one`, async () => {
        const answered = await put(opened(), `edited`, { "if-match": `"10-100"` });
        expect(answered.status).toBe(200);
        expect(answered.headers.get(`etag`)).toBe(`"20-200"`);
        expect(await answered.json()).toEqual({ path: `brief.docx`, version: `20-200` });
        expect(writes).toEqual([{ path: `brief.docx`, body: `edited`, write: { kind: `save`, expected: `10-100` } }]);
    });

    it(`answers 409 when the file changed on disk, so the page can ask the owner`, async () => {
        answer = { conflict: true };
        const answered = await put(opened(), `edited`, { "if-match": `"10-100"` });
        expect(answered.status).toBe(409);
        expect(await answered.json()).toEqual({ error: `the file changed on disk` });
    });

    it(`answers a write the backend refuses with its reason, as a 403`, async () => {
        answer = { refused: `no copies here` };
        const answered = await put(opened(), `both`, {}, `&write=copy`);
        expect([answered.status, await answered.json()]).toEqual([403, { error: `no copies here` }]);
    });

    it(`refuses a save that names no version, unless it asks to overwrite or copy`, async () => {
        const session = opened();
        expect((await put(session, `edited`)).status).toBe(428);
        expect((await put(session, `mine`, {}, `&write=overwrite`)).status).toBe(200);
        expect((await put(session, `both`, {}, `&write=copy`)).status).toBe(200);
        expect((await put(session, `odd`, {}, `&write=delete`)).status).toBe(428);
        expect(writes.map((write) => write.write)).toEqual([{ kind: `overwrite` }, { kind: `copy` }]);
    });

    it(`refuses a view-only session and a conversation's copy`, async () => {
        expect((await put(opened({ mode: `view` }), `x`, { "if-match": `"10-100"` })).status).toBe(403);
        expect((await put(opened({ agent: `turn-1`, mode: `edit` }), `x`, { "if-match": `"10-100"` })).status).toBe(403);
        expect(writes).toEqual([]);
    });

    it(`refuses a body past the size limit, declared or streamed`, async () => {
        const session = opened();
        expect((await put(session, `x`.repeat(LIMIT + 1), { "if-match": `"10-100"` })).status).toBe(413);
        // SAFETY: `duplex` is what a streamed request body needs, and not yet in the DOM typings of RequestInit.
        const streamed = await call(`/file?s=${session.token}`, {
            method: `PUT`,
            headers: { "if-match": `"10-100"` },
            body: new Blob([`x`.repeat(LIMIT * 4)]).stream(),
            duplex: `half`,
        } as RequestInit);
        expect(streamed.status).toBe(413);
    });

    it(`does nothing else with the document's route`, async () => {
        expect((await call(`/file?s=${opened().token}`, { method: `DELETE` })).status).toBe(405);
    });
});

describe(`the static trees`, () => {
    it(`serve the bundle and the page under their own ids and nothing else`, async () => {
        expect(await (await call(`/bundle/pin-1/web-apps/api.js`)).text()).toBe(`api`);
        expect(await (await call(`/page/abc123/editor.js`)).text()).toBe(`page`);
        expect((await call(`/bundle/pin-0/web-apps/api.js`)).status).toBe(404);
        expect((await call(`/page/old/editor.js`)).status).toBe(404);
        expect((await call(`/bundle/pin-1`)).status).toBe(404);
    });

    it(`404 the bundle while it is not on disk yet`, async () => {
        bundleReady = false;
        expect((await call(`/bundle/pin-1/web-apps/api.js`)).status).toBe(404);
    });

    it(`leave every other path to the rest of the listener`, async () => {
        expect((await call(`/web-apps/apps/api/documents/api.js`)).status).toBe(418);
        expect((await call(`/bundle/pin-1/web-apps/api.js`, { method: `POST` })).status).toBe(418);
    });
});

describe(`reading a version back`, () => {
    it(`takes the quotes and the weak marker off an ETag`, () => {
        expect(versionOf(`"10-100"`)).toBe(`10-100`);
        expect(versionOf(`W/"10-100"`)).toBe(`10-100`);
        expect(versionOf(`10-100`)).toBe(`10-100`);
        expect(versionOf(`""`)).toBeUndefined();
        expect(versionOf(undefined)).toBeUndefined();
    });
});
