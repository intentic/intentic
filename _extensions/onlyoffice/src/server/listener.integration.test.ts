import http from "node:http";
import { Readable } from "node:stream";
import { signJwt } from "./jwt.js";
import { createListener, type Listener } from "./listener.js";
import { Sessions, type FileStat } from "./sessions.js";

// The listener against a stand-in document server: the routes of its own, and the proxy for everything else.

const secret = `listener-secret`;
const sessions = new Sessions();
let listener: Listener;
let port = 0;
let documentServerPort: number | undefined;
let fakeServer: http.Server;
const saved: { path: string; url: string }[] = [];
const logged: string[] = [];
// What the fake write leaves on disk, and a gate a test can hold a write at.
const written: FileStat = { size: 9, mtimeMs: 9000 };
let holdWrite: Promise<void> | undefined;

const listen = (server: http.Server): Promise<number> =>
    new Promise((resolve) => {
        server.listen(0, `127.0.0.1`, () => {
            const address = server.address();
            resolve(typeof address === `object` && address !== null ? address.port : 0);
        });
    });

beforeAll(async () => {
    fakeServer = http.createServer((req, res) => {
        if (req.url === `/healthcheck`) {
            res.end(`true`);
            return;
        }
        res.writeHead(200, {
            "content-type": `text/plain`,
            "x-upstream-path": req.url ?? ``,
            "x-upstream-forwarded-host": req.headers[`x-forwarded-host`] ?? `-`,
            "x-upstream-forwarded-proto": req.headers[`x-forwarded-proto`] ?? `-`,
            connection: `close`,
        });
        res.end(`upstream says hi`);
    });
    // The editors' socket.io connection: answered 101, then held open until the client lets go.
    fakeServer.on(`upgrade`, (req, socket) => {
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
        socket.on(`error`, () => socket.destroy());
        // The server's own end of a session (its idle timeout, a drop): it closes, the browser never says a word.
        if (req.url?.startsWith(`/server-ends`) === true) {
            setTimeout(() => socket.end(), 20);
        }
    });
    documentServerPort = await listen(fakeServer);
    listener = createListener({
        secret,
        sessions,
        documentServerPort: () => documentServerPort,
        pageFor: (session) => `<html>${session.path}:${session.mode}</html>`,
        refresh: async (session) => {
            if (session.path === `gone.docx`) {
                return undefined;
            }
            const renewed = sessions.renew(session.token, { path: session.path, agent: undefined, mode: session.mode, theme: session.theme, stat: written });
            return { document: { key: renewed?.key } };
        },
        readDocument: async (document) => (document.path === `gone.docx` ? undefined : Readable.from([Buffer.from(`bytes of ${document.path}`)])),
        saveDocument: async (document, url) => {
            await holdWrite;
            if (document.path === `refused.docx`) {
                throw new Error(`refused`);
            }
            saved.push({ path: document.path, url });
            return written;
        },
        log: (line) => logged.push(line),
    });
    port = await listener.listen();
});

afterAll(async () => {
    await listener.close();
    await new Promise((resolve) => fakeServer.close(resolve));
});

const call = (path: string, init?: RequestInit): Promise<Response> => fetch(`http://127.0.0.1:${port}${path}`, init);
const open = (path: string, stat: FileStat = { size: 1, mtimeMs: 1 }): ReturnType<Sessions[`open`]> =>
    sessions.open({ path, agent: undefined, mode: `edit`, theme: `light`, stat });

describe(`the editor page`, () => {
    it(`answers a live session token and ends politely for an unknown one`, async () => {
        const session = open(`brief.docx`);
        const page = await call(`/editor?s=${session.token}`);
        expect(page.status).toBe(200);
        expect(await page.text()).toBe(`<html>brief.docx:edit</html>`);
        const ended = await call(`/editor?s=nope`);
        expect(ended.status).toBe(404);
        expect(await ended.text()).toContain(`This editor session has ended`);
    });
});

describe(`the document the server fetches`, () => {
    it(`streams the bytes to a caller signed with the shared secret and nobody else`, async () => {
        const session = open(`brief.docx`);
        const signed = await call(`/doc/${session.key}`, { headers: { authorization: `Bearer ${signJwt({ url: `x` }, secret)}` } });
        expect(signed.status).toBe(200);
        expect(await signed.text()).toBe(`bytes of brief.docx`);
        expect((await call(`/doc/${session.key}`)).status).toBe(401);
        expect((await call(`/doc/${session.key}`, { headers: { authorization: `Bearer ${signJwt({ url: `x` }, `wrong`)}` } })).status).toBe(401);
    });

    it(`404s a key nothing opened, and a document that left the disk`, async () => {
        const headers = { authorization: `Bearer ${signJwt({}, secret)}` };
        expect((await call(`/doc/unknown`, { headers })).status).toBe(404);
        expect((await call(`/doc/${open(`gone.docx`).key}`, { headers })).status).toBe(404);
    });
});

describe(`the save callback`, () => {
    const post = (key: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
        call(`/callback/${key}`, { method: `POST`, headers: { "content-type": `application/json`, ...headers }, body: JSON.stringify(body) });

    it(`writes on "ready for saving" (2) and on a forced save (6), trusting only the signed claims`, async () => {
        const session = open(`brief.docx`);
        const claims = { key: session.key, status: 2, url: `http://localhost:80/cache/files/out.docx` };
        const inBody = await post(session.key, { ...claims, token: signJwt(claims, secret) });
        expect(await inBody.json()).toEqual({ error: 0 });
        // Header-signed, with the tampered raw body ignored in favour of the signed copy.
        const inHeader = await post(
            session.key,
            { status: 4, url: `http://evil/` },
            { authorization: `Bearer ${signJwt({ payload: { ...claims, status: 6 } }, secret)}` },
        );
        expect(await inHeader.json()).toEqual({ error: 0 });
        expect(saved.slice(-2)).toEqual([
            { path: `brief.docx`, url: claims.url },
            { path: `brief.docx`, url: claims.url },
        ]);
    });

    it(`keeps the key after a forced save and retires it after the final one`, async () => {
        const session = open(`kept.docx`);
        const signed = (status: number, extra: Record<string, unknown> = {}): Record<string, unknown> => {
            const claims = { key: session.key, status, url: `http://localhost/out.docx`, ...extra };
            return { ...claims, token: signJwt(claims, secret) };
        };
        expect(await (await post(session.key, signed(6))).json()).toEqual({ error: 0 });
        // A second tab over the bytes that save left joins the session.
        expect(open(`kept.docx`, written).key).toBe(session.key);
        expect(await (await post(session.key, signed(2))).json()).toEqual({ error: 0 });
        // The server holds a key it closed as outdated: the next open is a new session over the same bytes.
        expect(open(`kept.docx`, written).key).not.toBe(session.key);
    });

    it(`writes nothing for a final save that says nothing changed since the last forced one, and still retires the key`, async () => {
        const session = open(`untouched.docx`);
        const before = saved.length;
        const claims = { key: session.key, status: 2, url: `http://localhost/out.docx`, notmodified: true };
        expect(await (await post(session.key, { ...claims, token: signJwt(claims, secret) })).json()).toEqual({ error: 0 });
        expect(saved.length).toBe(before);
        expect(open(`untouched.docx`).key).not.toBe(session.key);
        // A failed save (3) ends the session as well.
        const failed = open(`failed.docx`);
        const notice = { key: failed.key, status: 3 };
        expect(await (await post(failed.key, { ...notice, token: signJwt(notice, secret) })).json()).toEqual({ error: 0 });
        expect(open(`failed.docx`).key).not.toBe(failed.key);
    });

    it(`acknowledges a lifecycle notice without writing, and refuses an unsigned or missigned post`, async () => {
        const session = open(`other.docx`);
        const before = saved.length;
        const notice = { key: session.key, status: 1, actions: [{ type: 1, userid: `owner` }] };
        expect(await (await post(session.key, { ...notice, token: signJwt(notice, secret) })).json()).toEqual({ error: 0 });
        expect(saved.length).toBe(before);
        expect((await post(session.key, { status: 2, url: `http://x/` })).status).toBe(401);
        expect((await post(session.key, { status: 2, url: `http://x/`, token: signJwt({ status: 2 }, `wrong`) })).status).toBe(401);
        expect((await post(`unknown`, { token: signJwt({ status: 2, url: `http://x/` }, secret) })).status).toBe(404);
    });

    it(`tells the server a failed write failed, so it keeps the document`, async () => {
        const session = open(`refused.docx`);
        const claims = { status: 2, url: `http://x/out.docx` };
        expect(await (await post(session.key, { ...claims, token: signJwt(claims, secret) })).json()).toEqual({ error: 1 });
        expect(logged.some((line) => line.includes(`saving refused.docx failed: refused`))).toBe(true);
        // The server restores such a session rather than closing it, so its key stays usable.
        expect(open(`refused.docx`).key).toBe(session.key);
    });
});

describe(`a refresh`, () => {
    it(`moves the page's session onto a fresh key, after its key's final save has landed`, async () => {
        const session = open(`refresh.docx`);
        let release = (): void => undefined;
        holdWrite = new Promise((resolve) => {
            release = resolve;
        });
        const claims = { key: session.key, status: 2, url: `http://localhost/out.docx` };
        const saving = call(`/callback/${session.key}`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ ...claims, token: signJwt(claims, secret) }),
        });
        const refreshing = call(`/refresh?s=${session.token}`);
        let answered = false;
        void refreshing.then(() => {
            answered = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(answered).toBe(false);
        release();
        holdWrite = undefined;
        expect(await (await saving).json()).toEqual({ error: 0 });
        const fresh = (await (await refreshing).json()) as { document: { key: string } };
        expect(fresh.document.key).not.toBe(session.key);
        expect(sessions.session(session.token)?.key).toBe(fresh.document.key);
    });

    it(`answers 404 for a session that ended and for a document that is gone`, async () => {
        expect((await call(`/refresh?s=never-issued`)).status).toBe(404);
        expect((await call(`/refresh?s=${open(`gone.docx`).token}`)).status).toBe(404);
    });
});

describe(`the editors' sockets`, () => {
    it(`are counted while they are open, so an editor nobody types in still holds the server up`, async () => {
        expect(listener.editorsConnected()).toBe(0);
        const socket = await new Promise<import("node:net").Socket>((resolve, reject) => {
            const request = http.request({ host: `127.0.0.1`, port, path: `/doc/x/c/?EIO=4&transport=websocket`, headers: { connection: `Upgrade`, upgrade: `websocket` } });
            request.on(`upgrade`, (_answer, upgraded) => resolve(upgraded as import("node:net").Socket));
            request.on(`error`, reject);
            request.end();
        });
        expect(listener.editorsConnected()).toBe(1);
        const closed = new Promise((resolve) => socket.on(`close`, resolve));
        socket.destroy();
        await closed;
        // The listener's side of the socket closes a tick after the client's.
        for (let attempt = 0; attempt < 50 && listener.editorsConnected() > 0; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(listener.editorsConnected()).toBe(0);
    });

    it(`are no longer counted once the document server ends them, without waiting for the browser`, async () => {
        const socket = await new Promise<import("node:net").Socket>((resolve, reject) => {
            const request = http.request({ host: `127.0.0.1`, port, path: `/server-ends`, headers: { connection: `Upgrade`, upgrade: `websocket` } });
            request.on(`upgrade`, (_answer, upgraded) => resolve(upgraded as import("node:net").Socket));
            request.on(`error`, reject);
            request.end();
        });
        socket.on(`error`, () => socket.destroy());
        expect(listener.editorsConnected()).toBe(1);
        for (let attempt = 0; attempt < 50 && listener.editorsConnected() > 0; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(listener.editorsConnected()).toBe(0);
        socket.destroy();
    });
});

describe(`everything else`, () => {
    it(`is the document server's, proxied on this origin with the forwarded host the proxy in front named`, async () => {
        const response = await call(`/web-apps/apps/api/documents/api.js?x=1`, {
            headers: { "x-forwarded-host": `port-abc-def.localhost:30559`, "x-forwarded-proto": `http` },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get(`x-upstream-path`)).toBe(`/web-apps/apps/api/documents/api.js?x=1`);
        expect(response.headers.get(`x-upstream-forwarded-host`)).toBe(`port-abc-def.localhost:30559`);
        expect(response.headers.get(`x-upstream-forwarded-proto`)).toBe(`http`);
        expect(await response.text()).toBe(`upstream says hi`);
    });

    it(`answers 503 while the document server is down, and keeps its own routes`, async () => {
        const was = documentServerPort;
        documentServerPort = undefined;
        try {
            expect((await call(`/web-apps/x`)).status).toBe(503);
            expect((await call(`/editor?s=nope`)).status).toBe(404);
        } finally {
            documentServerPort = was;
        }
    });
});
