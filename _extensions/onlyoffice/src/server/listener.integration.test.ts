import http from "node:http";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signJwt } from "./jwt.js";
import { createListener, type Listener } from "./listener.js";
import { Sessions } from "./sessions.js";

// The listener against a stand-in document server: the routes of its own, and the proxy for everything else.

const secret = `listener-secret`;
const sessions = new Sessions();
let listener: Listener;
let port = 0;
let documentServerPort: number | undefined;
let publicOrigin: string | undefined = `https://port-abc-def.docs.example.test`;
let fakeServer: http.Server;
const saved: { key: string; path: string; url: string }[] = [];
const logged: string[] = [];

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
    documentServerPort = await listen(fakeServer);
    listener = createListener({
        secret,
        sessions,
        documentServerPort: () => documentServerPort,
        publicOrigin: () => publicOrigin,
        pageFor: (session) => `<html>${session.path}:${session.mode}</html>`,
        readDocument: async (document) => (document.path === `gone.docx` ? undefined : Readable.from([Buffer.from(`bytes of ${document.path}`)])),
        saveDocument: async (key, document, url) => {
            if (document.path === `refused.docx`) {
                throw new Error(`refused`);
            }
            saved.push({ key, path: document.path, url });
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
const open = (path: string): ReturnType<Sessions[`open`]> => sessions.open({ path, agent: undefined, mode: `edit`, theme: `light`, stat: { size: 1, mtimeMs: 1 } });

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
        const inHeader = await post(session.key, { status: 4, url: `http://evil/` }, { authorization: `Bearer ${signJwt({ payload: { ...claims, status: 6 } }, secret)}` });
        expect(await inHeader.json()).toEqual({ error: 0 });
        expect(saved).toEqual([
            { key: session.key, path: `brief.docx`, url: claims.url },
            { key: session.key, path: `brief.docx`, url: claims.url },
        ]);
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
    });
});

describe(`everything else`, () => {
    it(`is the document server's, proxied on this origin, and told the public origin it is reached at`, async () => {
        const response = await call(`/web-apps/apps/api/documents/api.js?x=1`);
        expect(response.status).toBe(200);
        expect(response.headers.get(`x-upstream-path`)).toBe(`/web-apps/apps/api/documents/api.js?x=1`);
        // The server builds the download URLs it hands the editor from these; localhost here would be the sandbox's.
        expect(response.headers.get(`x-upstream-forwarded-host`)).toBe(`port-abc-def.docs.example.test`);
        expect(response.headers.get(`x-upstream-forwarded-proto`)).toBe(`https`);
        expect(await response.text()).toBe(`upstream says hi`);
    });

    it(`keeps the forwarded host the proxy in front already named: the lane the browser is on, not the backend's guess`, async () => {
        const response = await call(`/web-apps/x`, { headers: { "x-forwarded-host": `port-abc-def.localhost:30559`, "x-forwarded-proto": `http` } });
        expect(response.headers.get(`x-upstream-forwarded-host`)).toBe(`port-abc-def.localhost:30559`);
        expect(response.headers.get(`x-upstream-forwarded-proto`)).toBe(`http`);
    });

    it(`leaves the forwarded headers alone while no public origin is known`, async () => {
        const was = publicOrigin;
        publicOrigin = undefined;
        try {
            const response = await call(`/web-apps/x`);
            expect(response.headers.get(`x-upstream-forwarded-host`)).toBe(`-`);
        } finally {
            publicOrigin = was;
        }
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
