import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_ELEMENT_ID, type EditorPageConfig } from "../../protocol.js";
import type { OpenRequest } from "../../contract.js";
import type { BundlePin } from "../bundle-pin.js";
import { BundleStore } from "../bundle.js";
import { copyNameFor, createBrowserEngine, originOf, versionOfStat, type BrowserEngine, type BrowserEngineDeps } from "../browser-engine.js";
import { Sessions, type FileStat } from "../sessions.js";

// The browser engine's backend against a temp workspace, a bundle already verified on disk, and a real HTTP server in
// front of its routes: what an open answers, the page a session is framed with, and what each kind of write leaves.

const pin: BundlePin = {
    id: `test-pin`,
    url: `https://example.test/never-fetched.tar.gz`,
    approximateBytes: 1,
    stripPrefix: `x/`,
    keep: [],
    files: 0,
    digest: `d1`,
    patches: [],
};

let dir: string;
let workspace: string;
let server: http.Server;
let port = 0;
let sessions: Sessions;
let engine: BrowserEngine;
// Where the browser reaches the listener; undefined plays a sandbox with no public address yet.
let exposed: string | undefined = `https://port-1.example`;

const identify = async (path: string, agent: string | undefined): Promise<{ stat?: FileStat; digest?: string } | undefined> => {
    if (agent !== undefined) {
        return { digest: `copy-digest` };
    }
    try {
        const found = await stat(join(workspace, path));
        return { stat: { size: found.size, mtimeMs: found.mtimeMs } };
    } catch {
        // allow(silent-catch): a file that is not there is the undefined the engine answers 404 for.
        return undefined;
    }
};

// What the desktop app's backend adds to an engine: where a window may write, and what runs before an overwrite.
type Hooks = Pick<BrowserEngineDeps, "writable" | "beforeOverwrite">;

const make = async (bundleReady: boolean, fetchImpl?: typeof fetch, hooks: Hooks = {}): Promise<void> => {
    const root = join(dir, `cache`, `bundle`);
    await rm(root, { recursive: true, force: true });
    if (bundleReady) {
        await mkdir(join(root, pin.id), { recursive: true });
        await writeFile(join(root, pin.id, `.verified`), `${pin.digest}\n`);
    }
    sessions = new Sessions();
    const bundle = new BundleStore({ root, pin, log: () => undefined, fetch: fetchImpl });
    await bundle.load();
    engine = createBrowserEngine({
        workspaceRoot: workspace,
        pageDir: join(dir, `page`),
        sessions,
        bundle,
        scopedRaw: async () => new Response(`copy bytes`),
        identify,
        exposure: async () => exposed,
        log: () => undefined,
        ...hooks,
    });
};

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), `oo-engine-`));
    workspace = join(dir, `work`);
    await mkdir(join(dir, `page`), { recursive: true });
    await writeFile(join(dir, `page`, `editor.js`), `/* page */`);
    server = http.createServer((req, res) => {
        const url = new URL(req.url ?? `/`, `http://engine`);
        engine
            .routes(req, res, url)
            .then((handled) => {
                if (!handled) {
                    res.writeHead(418);
                    res.end();
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

beforeEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await mkdir(join(workspace, `docs`), { recursive: true });
    await writeFile(join(workspace, `docs`, `brief.docx`), `original`);
    await writeFile(join(workspace, `docs`, `old.doc`), `legacy`);
    exposed = `https://port-1.example`;
    await make(true);
});

const request = (overrides: Partial<OpenRequest> = {}): OpenRequest => ({
    path: `docs/brief.docx`,
    mode: `edit`,
    theme: `light`,
    engine: `browser`,
    ...overrides,
});

// Opens `request` and answers the session it made.
const opened = async (overrides: Partial<OpenRequest> = {}): Promise<ReturnType<Sessions[`session`]>> => {
    const answer = await engine.open(request(overrides));
    expect(answer.status).toBe(200);
    const token = `session` in answer.body ? answer.body.session : ``;
    return sessions.session(token);
};

const configIn = (page: string): EditorPageConfig => {
    const match = new RegExp(`<script id="${CONFIG_ELEMENT_ID}" type="application/json">(.*?)</script>`).exec(page);
    // SAFETY: the element browserPage renders from an EditorPageConfig; the tests read its fields by name.
    return JSON.parse(match?.[1] ?? `{}`) as EditorPageConfig;
};

const call = (path: string, init?: RequestInit): Promise<Response> => fetch(`http://127.0.0.1:${port}${path}`, init);

const versionOnDisk = async (path: string): Promise<string> => versionOfStat(await stat(join(workspace, path)));

describe(`opening a document`, () => {
    it(`frames the listener's editor page under a new browser-engine session`, async () => {
        const answer = await engine.open(request({ lang: `de`, origin: `https://app.example` }));
        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({ engine: `browser`, url: expect.stringMatching(/^https:\/\/port-1\.example\/editor\?s=[\w-]+$/) });
        const token = `session` in answer.body ? answer.body.session : ``;
        expect(sessions.session(token)).toMatchObject({
            path: `docs/brief.docx`,
            mode: `edit`,
            engine: `browser`,
            lang: `de`,
            origin: `https://app.example`,
        });
    });

    it(`opens a legacy binary format and a conversation's copy view-only, whatever was asked`, async () => {
        expect((await opened({ path: `docs/old.doc` }))?.mode).toBe(`view`);
        expect((await opened({ agent: `conv-1` }))?.mode).toBe(`view`);
    });

    it(`shows a kept editor again while it still holds the file`, async () => {
        const kept = await opened();
        expect((await engine.open(request({ resume: kept?.token ?? `` }))).body).toEqual({ resumed: true });
    });

    it(`answers why there is no editor yet: no address, no such file, no page build`, async () => {
        exposed = undefined;
        expect(await engine.open(request())).toEqual({ status: 409, body: { state: `no-address` } });
        exposed = `https://port-1.example`;
        expect((await engine.open(request({ path: `docs/gone.docx` }))).status).toBe(404);
        await rm(join(dir, `page`, `editor.js`));
        await make(true);
        expect(await engine.open(request())).toEqual({
            status: 409,
            body: { state: `error`, detail: `The document editor isn't included in this copy of Intentic.` },
        });
        await writeFile(join(dir, `page`, `editor.js`), `/* page */`);
    });

    it(`starts the bundle's download on the first open and answers its progress`, async () => {
        const fetches: string[] = [];
        // A download that never answers, so the state stays where the first open put it.
        // SAFETY: a stand-in for fetch that reads only the URL it is asked for.
        await make(false, (async (input: string | URL | Request) => {
            fetches.push(String(input));
            return new Promise<Response>(() => undefined);
        }) as typeof fetch);
        expect(await engine.open(request())).toEqual({ status: 409, body: { state: `pulling`, percent: 0 } });
        expect(await engine.status()).toEqual({ state: `pulling`, percent: 0 });
        // The request goes out once the scratch directory is ready, a few turns of the loop after the open answered.
        for (let turn = 0; turn < 200 && fetches.length === 0; turn++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(fetches).toEqual([pin.url]);
    });
});

describe(`the page a session is framed with`, () => {
    it(`carries the file's version, where to read and write it, and whether it can be written back`, async () => {
        const session = await opened({ lang: `pl`, origin: `https://app.example`, theme: `dark` });
        if (session === undefined) {
            throw new Error(`no session`);
        }
        const page = await engine.page(session);
        expect(page).toContain(`<script src="/bundle/test-pin/web-apps/apps/api/documents/api.js"></script>`);
        expect(page).toMatch(/<script src="\/page\/[0-9a-f]{16}\/editor\.js"><\/script>/);
        const config = configIn(page);
        expect(config).toMatchObject({
            title: `brief.docx`,
            fileType: `docx`,
            documentType: `word`,
            mode: `edit`,
            theme: `dark`,
            lang: `pl`,
            fileUrl: `/file?s=${session.token}`,
            version: await versionOnDisk(`docs/brief.docx`),
            saveable: true,
            parentOrigin: `https://app.example`,
        });
        expect(config.key).toMatch(/^[0-9A-Za-z._=-]{1,128}$/);
        // A fresh key per load, so the editor never shows a conversion it cached from other bytes.
        expect(configIn(await engine.page(session)).key).not.toBe(config.key);
    });

    // Opened from a desktop app's window on Linux or macOS: without its origin the page posts nothing, so the viewer
    // never hears a save (no kept original to offer), an unsaved edit or a conflict.
    it(`posts to the desktop app's own window`, async () => {
        const session = await opened({ origin: `tauri://localhost` });
        if (session === undefined) {
            throw new Error(`no session`);
        }
        expect(configIn(await engine.page(session)).parentOrigin).toBe(`tauri://localhost`);
    });

    it(`is not saveable for a legacy format`, async () => {
        const session = await opened({ path: `docs/old.doc` });
        if (session === undefined) {
            throw new Error(`no session`);
        }
        expect(configIn(await engine.page(session))).toMatchObject({ mode: `view`, saveable: false, documentType: `word` });
    });
});

describe(`writing the document`, () => {
    const put = (token: string, body: string, headers: Record<string, string> = {}, query = ``): Promise<Response> =>
        call(`/file?s=${token}${query}`, { method: `PUT`, body, headers });

    it(`writes a save over the version it names, and the kept editor still holds the file after it`, async () => {
        const session = await opened();
        const token = session?.token ?? ``;
        const read = await call(`/file?s=${token}`);
        const etag = read.headers.get(`etag`) ?? ``;
        expect(await read.text()).toBe(`original`);
        const saved = await put(token, `edited`, { "if-match": etag });
        expect(saved.status).toBe(200);
        expect(await saved.json()).toEqual({ path: `docs/brief.docx`, version: await versionOnDisk(`docs/brief.docx`) });
        expect(await readFile(join(workspace, `docs`, `brief.docx`), `utf8`)).toBe(`edited`);
        const found = await stat(join(workspace, `docs`, `brief.docx`));
        expect(
            sessions.current(token, {
                path: `docs/brief.docx`,
                agent: undefined,
                mode: `edit`,
                theme: `light`,
                stat: { size: found.size, mtimeMs: found.mtimeMs },
                engine: `browser`,
            }),
        ).toBe(true);
        expect((await readdir(join(workspace, `docs`))).toSorted()).toEqual([`brief.docx`, `old.doc`]);
    });

    it(`writes nothing over a file that changed on disk since, and leaves no scratch behind`, async () => {
        const session = await opened();
        const etag = (await call(`/file?s=${session?.token ?? ``}`)).headers.get(`etag`) ?? ``;
        await writeFile(join(workspace, `docs`, `brief.docx`), `an agent's edit`);
        expect((await put(session?.token ?? ``, `edited`, { "if-match": etag })).status).toBe(409);
        expect(await readFile(join(workspace, `docs`, `brief.docx`), `utf8`)).toBe(`an agent's edit`);
        expect((await readdir(join(workspace, `docs`))).toSorted()).toEqual([`brief.docx`, `old.doc`]);
    });

    it(`answers a save of a file that was deleted meanwhile as a conflict`, async () => {
        const session = await opened();
        await rm(join(workspace, `docs`, `brief.docx`));
        expect((await put(session?.token ?? ``, `edited`, { "if-match": `"8-1"` })).status).toBe(409);
    });

    it(`writes over the change when the owner keeps theirs, and beside it when they keep both`, async () => {
        const session = await opened();
        const token = session?.token ?? ``;
        await writeFile(join(workspace, `docs`, `brief.docx`), `an agent's edit`);
        const copied = await put(token, `mine`, {}, `&write=copy`);
        expect(await copied.json()).toMatchObject({ path: `docs/brief (copy).docx` });
        expect(await (await put(token, `mine again`, {}, `&write=copy`)).json()).toMatchObject({ path: `docs/brief (copy 2).docx` });
        expect(await readFile(join(workspace, `docs`, `brief (copy).docx`), `utf8`)).toBe(`mine`);
        expect(await readFile(join(workspace, `docs`, `brief.docx`), `utf8`)).toBe(`an agent's edit`);
        expect((await put(token, `mine, over theirs`, {}, `&write=overwrite`)).status).toBe(200);
        expect(await readFile(join(workspace, `docs`, `brief.docx`), `utf8`)).toBe(`mine, over theirs`);
    });

    // A document opened on its own on the user's computer may be written, and nothing beside it.
    it(`writes no copy where the window may not write, and nothing is left behind`, async () => {
        await make(true, undefined, { writable: (path) => path === `docs/brief.docx` });
        const session = await opened();
        const copied = await put(session?.token ?? ``, `mine`, {}, `&write=copy`);
        expect([copied.status, await copied.json()]).toEqual([
            403,
            { error: `Only the document itself can be saved from this window, so a copy can't be kept beside it.` },
        ]);
        expect((await readdir(join(workspace, `docs`))).toSorted()).toEqual([`brief.docx`, `old.doc`]);
    });

    // Where the desktop app keeps the original: the bytes it replaces are still on disk when it runs.
    it(`runs the overwrite hook before a save and an overwrite, with the old bytes still there, and not for a copy`, async () => {
        const seen: [string, string][] = [];
        await make(true, undefined, {
            beforeOverwrite: async (path) => {
                seen.push([path, await readFile(join(workspace, path), `utf8`)]);
            },
        });
        const session = await opened();
        const token = session?.token ?? ``;
        const etag = (await call(`/file?s=${token}`)).headers.get(`etag`) ?? ``;
        expect((await put(token, `edited`, { "if-match": etag })).status).toBe(200);
        expect((await put(token, `mine`, {}, `&write=overwrite`)).status).toBe(200);
        expect((await put(token, `both`, {}, `&write=copy`)).status).toBe(200);
        expect(seen).toEqual([
            [`docs/brief.docx`, `original`],
            [`docs/brief.docx`, `edited`],
        ]);
    });

    it(`reads a conversation's copy without a version, since it is never written back`, async () => {
        const session = await opened({ agent: `conv-1` });
        const read = await call(`/file?s=${session?.token ?? ``}`);
        expect(read.headers.get(`etag`)).toBeNull();
        expect(await read.text()).toBe(`copy bytes`);
    });
});

describe(`the pieces`, () => {
    it(`names a copy beside the file, at the top level and in a folder`, async () => {
        expect(await copyNameFor(workspace, `docs/brief.docx`)).toBe(`docs/brief (copy).docx`);
        await writeFile(join(workspace, `top.xlsx`), `x`);
        expect(await copyNameFor(workspace, `top.xlsx`)).toBe(`top (copy).xlsx`);
    });

    it(`takes only a bare http(s) origin, or the desktop app's own, as where the page may post`, () => {
        expect(originOf(`https://app.example`)).toBe(`https://app.example`);
        expect(originOf(`http://localhost:5173`)).toBe(`http://localhost:5173`);
        // The desktop app's windows on Linux and macOS (on Windows it is http://tauri.localhost, above's kind).
        expect(originOf(`tauri://localhost`)).toBe(`tauri://localhost`);
        expect(originOf(`https://app.example/`)).toBeUndefined();
        expect(originOf(`tauri://localhost/files/local`)).toBeUndefined();
        expect(originOf(`tauri://`)).toBeUndefined();
        expect(originOf(`javascript://localhost`)).toBeUndefined();
        expect(originOf(`javascript:alert(1)`)).toBeUndefined();
        expect(originOf(`*`)).toBeUndefined();
        expect(originOf(undefined)).toBeUndefined();
    });
});
