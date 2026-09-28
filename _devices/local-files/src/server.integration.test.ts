import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalOffice } from "@intentic/ext-onlyoffice/local-office";
import { sha256Text } from "./files.js";
import { type Grant, Grants } from "./grants.js";
import { createLocalFilesServer, type LocalFilesServer } from "./server.js";
import { Watches } from "./watch.js";

// The HTTP face, driven the way the editor drives it, over a real folder: the three gates first, then what each grant
// may read and write.

const PORT = 47001;
const APP = `tauri://localhost`;
const FOLDER_TOKEN = `f`.repeat(64);
const FILE_TOKEN = `d`.repeat(64);

// Office routes are the extension's own (onlyoffice/src/server/local-office.ts); these tests reach none of them.
const office: LocalOffice = {
    handle: async () => undefined,
    release: async () => undefined,
    close: async () => undefined,
};

let dir: string;
let server: LocalFilesServer;
beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), `local-files-server-`)));
    mkdirSync(join(dir, `docs`));
    writeFileSync(join(dir, `docs`, `a.md`), `# a`);
    writeFileSync(join(dir, `notes.txt`), `notes`);
    const grants = new Grants();
    const folder: Grant = { token: FOLDER_TOKEN, id: `w1`, root: dir, name: `project` };
    const file: Grant = { token: FILE_TOKEN, id: `w2`, root: dir, file: `notes.txt`, name: `notes.txt` };
    grants.add(folder);
    grants.add(file);
    server = createLocalFilesServer({
        grants,
        office,
        context: { watches: new Watches(() => undefined), build: `test`, startedAt: 0 },
        origins: new Set([APP]),
        log: () => undefined,
    });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ask = (path: string, init: RequestInit & { token?: string; host?: string; origin?: string } = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set(`host`, init.host ?? `127.0.0.1:${PORT}`);
    if (init.token !== undefined) {
        headers.set(`authorization`, `Bearer ${init.token}`);
    }
    if (init.origin !== undefined) {
        headers.set(`origin`, init.origin);
    }
    return server.fetch(new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers }), PORT);
};

describe(`the gates`, () => {
    it(`refuses a request naming another host, as a rebound page's does`, async () => {
        expect((await ask(`/workspace/tree`, { token: FOLDER_TOKEN, host: `evil.example:${PORT}` })).status).toBe(421);
    });

    it(`refuses a page of any origin but the app's`, async () => {
        expect((await ask(`/workspace/tree`, { token: FOLDER_TOKEN, origin: `https://evil.example` })).status).toBe(403);
    });

    it(`refuses a request without a token it granted, and answers the unauthenticated health probe`, async () => {
        expect((await ask(`/workspace/tree`)).status).toBe(401);
        expect((await ask(`/workspace/tree`, { token: `x`.repeat(64) })).status).toBe(401);
        expect(await (await ask(`/health`)).json()).toEqual({ ok: true });
    });

    it(`answers the app's preflight, the private-network ask included`, async () => {
        const answer = await ask(`/workspace/tree`, {
            method: `OPTIONS`,
            origin: APP,
            headers: { "access-control-request-method": `GET`, "access-control-request-headers": `authorization`, "access-control-request-private-network": `true` },
        });
        expect(answer.status).toBe(204);
        expect(answer.headers.get(`access-control-allow-origin`)).toBe(APP);
        expect(answer.headers.get(`access-control-allow-headers`)).toBe(`authorization`);
        expect(answer.headers.get(`access-control-allow-private-network`)).toBe(`true`);
    });
});

describe(`reading`, () => {
    it(`serves the folder's tree and a file's text to its window`, async () => {
        // SAFETY: the route answers the contract's WorkspaceTree, of which only each entry's name is read; any other shape
        // fails the comparison below.
        const tree = (await (await ask(`/workspace/tree`, { token: FOLDER_TOKEN, origin: APP })).json()) as { tree: { name: string }[] };
        expect(tree.tree.map((entry) => entry.name)).toEqual([`docs`, `notes.txt`]);
        expect(await (await ask(`/workspace/file?path=docs/a.md`, { token: FOLDER_TOKEN })).json()).toEqual({
            present: true,
            path: `docs/a.md`,
            shared: true,
            content: `# a`,
            size: 3,
            offset: 0,
            bytes: 3,
        });
    });

    it(`answers a sandbox-only read with its empty truth rather than a 404`, async () => {
        expect(await (await ask(`/git/changes`, { token: FOLDER_TOKEN })).json()).toEqual({ repos: [], originAgents: {} });
    });
});

describe(`writing`, () => {
    it(`saves the editor's text when the file still holds what it read, and refuses when it does not`, async () => {
        const save = (text: string, base: string): Promise<Response> =>
            ask(`/workspace/upload?path=docs/a.md`, { method: `POST`, token: FOLDER_TOKEN, body: text, headers: { "x-intentic-base-hash": sha256Text(base) } });
        expect((await save(`# b`, `# a`)).status).toBe(200);
        expect(readFileSync(join(dir, `docs`, `a.md`), `utf8`)).toBe(`# b`);
        expect((await save(`# c`, `# a`)).status).toBe(409);
        expect(readFileSync(join(dir, `docs`, `a.md`), `utf8`)).toBe(`# b`);
    });

    // A document opened on its own reads its folder, for the pictures it points at, but writes only itself.
    it(`lets a document's window write that document and nothing beside it`, async () => {
        expect((await ask(`/workspace/upload?path=notes.txt`, { method: `POST`, token: FILE_TOKEN, body: `new notes` })).status).toBe(200);
        expect((await ask(`/workspace/upload?path=docs/a.md`, { method: `POST`, token: FILE_TOKEN, body: `x` })).status).toBe(403);
        expect(readFileSync(join(dir, `notes.txt`), `utf8`)).toBe(`new notes`);
    });
});
