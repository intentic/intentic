import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContractRoute, type Hello, HelloSchema, RAW_ROUTE_LIST, SANDBOX_ROUTES, sandboxRouteFor } from "@intentic/sandbox-contract";
import { sha256Text } from "./files.js";
import { type Grant, Grants } from "./grants.js";
import { unhurried } from "./server.js";
import { APP, type Ask, askerOf, localServer, PORT } from "./testing.js";

// The HTTP face, driven the way the editor drives it, over a real folder: the three gates first, then what each grant
// may read and write.

const FOLDER_TOKEN = `f`.repeat(64);
const FILE_TOKEN = `d`.repeat(64);
const READ_ONLY_TOKEN = `r`.repeat(64);
const HANDOFF_TOKEN = `h`.repeat(64);
// The web app at its own address, which a document is handed to.
const WEB = `https://app.intentic.dev`;

let dir: string;
let now: number;
let ask: (path: string, init?: Ask) => Promise<Response>;
beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), `local-files-server-`)));
    mkdirSync(join(dir, `docs`));
    writeFileSync(join(dir, `docs`, `a.md`), `# a`);
    writeFileSync(join(dir, `notes.txt`), `notes`);
    now = 0;
    const grants = new Grants(() => now);
    const folder: Grant = { token: FOLDER_TOKEN, id: `w1`, root: dir, name: `project` };
    const file: Grant = { token: FILE_TOKEN, id: `w2`, root: dir, file: `notes.txt`, name: `notes.txt` };
    grants.add(folder);
    grants.add(file);
    grants.add({ ...folder, token: READ_ONLY_TOKEN, id: `w3`, readOnly: true });
    grants.add({ ...file, token: HANDOFF_TOKEN, id: `w4`, origins: [WEB], expiresAt: 60_000 });
    ask = askerOf(localServer(grants));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

describe(`a document handed to another site`, () => {
    it(`serves that site its bytes, and nothing else`, async () => {
        const read = await ask(`/workspace/raw?path=notes.txt`, { token: HANDOFF_TOKEN, origin: WEB });
        expect([read.status, read.headers.get(`access-control-allow-origin`), await read.text()]).toEqual([200, WEB, `notes`]);
        expect((await ask(`/workspace/raw?path=notes.txt`, { method: `HEAD`, token: HANDOFF_TOKEN, origin: WEB })).status).toBe(200);
        const refused = await Promise.all(
            [`/workspace/raw?path=docs/a.md`, `/workspace/tree`, `/workspace/file?path=notes.txt`].map((path) => ask(path, { token: HANDOFF_TOKEN, origin: WEB })),
        );
        expect(await Promise.all(refused.map(async (answer) => [answer.status, await answer.json()]))).toEqual(
            Array.from({ length: 3 }, () => [403, { error: `this page may read only the document it was handed` }]),
        );
        const upload = await ask(`/workspace/upload?path=notes.txt`, { method: `POST`, token: HANDOFF_TOKEN, origin: WEB, body: `x` });
        expect(upload.status).toBe(403);
        expect(readFileSync(join(dir, `notes.txt`), `utf8`)).toBe(`notes`);
    });

    // The token opens the document for that site's pages only: not the app's, not a process with no page at all.
    it(`is refused to every other page, and that site gets nothing with an app window's token`, async () => {
        expect((await ask(`/workspace/raw?path=notes.txt`, { token: HANDOFF_TOKEN, origin: APP })).status).toBe(403);
        expect((await ask(`/workspace/raw?path=notes.txt`, { token: HANDOFF_TOKEN })).status).toBe(403);
        expect((await ask(`/workspace/raw?path=notes.txt`, { token: HANDOFF_TOKEN, origin: `https://evil.example` })).status).toBe(403);
        const theirs = await ask(`/workspace/tree`, { token: FOLDER_TOKEN, origin: WEB });
        expect([theirs.status, await theirs.json()]).toEqual([403, { error: `not this app's page` }]);
        expect(await (await ask(`/health`, { origin: WEB })).json()).toEqual({ ok: true });
    });

    // A preflight carries no bearer: the site is let through on the strength of a live grant naming it.
    it(`answers that site's preflight while the grant lives, and not after its end`, async () => {
        const preflight = (): Promise<Response> =>
            ask(`/workspace/raw?path=notes.txt`, {
                method: `OPTIONS`,
                origin: WEB,
                headers: { "access-control-request-method": `GET`, "access-control-request-headers": `authorization`, "access-control-request-private-network": `true` },
            });
        const answer = await preflight();
        expect([
            answer.status,
            answer.headers.get(`access-control-allow-origin`),
            answer.headers.get(`access-control-allow-methods`),
            answer.headers.get(`access-control-allow-private-network`),
        ]).toEqual([204, WEB, `GET, HEAD, OPTIONS`, `true`]);
        now = 60_000;
        expect((await preflight()).status).toBe(403);
        expect((await ask(`/workspace/raw?path=notes.txt`, { token: HANDOFF_TOKEN, origin: WEB })).status).toBe(403);
    });

    it(`answers its token 401 once the grant has ended`, async () => {
        now = 59_999;
        expect((await ask(`/workspace/raw?path=notes.txt`, { token: HANDOFF_TOKEN, origin: WEB })).status).toBe(200);
        now = 60_000;
        expect((await ask(`/workspace/raw?path=notes.txt`, { token: HANDOFF_TOKEN })).status).toBe(401);
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

    // The office viewer opens a document to read first, and edits it in the browser engine once asked.
    it(`tells the office viewer to open documents to read, in the browser engine`, async () => {
        expect(await (await ask(`/extensions/intentic.onlyoffice/settings`, { token: FOLDER_TOKEN })).json()).toEqual({
            settings: { engine: `browser`, openAs: `view` },
            secretsSet: [],
        });
    });
});

// The app re-points a window it reuses by granting its token again: what the old grant opened goes with it.
describe(`a token granted again`, () => {
    it(`serves the new grant's folder and rights, not the old one's`, async () => {
        const grants = new Grants();
        const other = join(dir, `docs`);
        grants.add({ token: FOLDER_TOKEN, id: `w1`, root: dir, name: `project` });
        const again = askerOf(localServer(grants));
        expect(await (await again(`/workspace/file?path=notes.txt`, { token: FOLDER_TOKEN })).json()).toMatchObject({ present: true, content: `notes` });
        grants.add({ token: FOLDER_TOKEN, id: `w1`, root: other, name: `docs`, readOnly: true });
        expect(await (await again(`/workspace/file?path=a.md`, { token: FOLDER_TOKEN })).json()).toMatchObject({ present: true, content: `# a` });
        expect(await (await again(`/workspace/file?path=notes.txt`, { token: FOLDER_TOKEN })).json()).toEqual({ present: false, path: `notes.txt` });
        expect((await again(`/workspace/upload?path=a.md`, { method: `POST`, token: FOLDER_TOKEN, body: `x` })).status).toBe(403);
    });
});

describe(`a file that is not UTF-8`, () => {
    it(`reads as lossy, and is not saved over as text`, async () => {
        writeFileSync(join(dir, `latin1.txt`), Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
        const read = await (await ask(`/workspace/file?path=latin1.txt`, { token: FOLDER_TOKEN })).json();
        expect(read).toEqual({ present: true, path: `latin1.txt`, shared: true, content: `caf\uFFFD\n`, size: 5, offset: 0, bytes: 5, lossy: true });
        const save = await ask(`/workspace/upload?path=latin1.txt`, {
            method: `POST`,
            token: FOLDER_TOKEN,
            body: `cafe\n`,
            headers: { "x-intentic-base-hash": sha256Text(`caf\uFFFD\n`) },
        });
        expect([save.status, await save.json()]).toEqual([422, { error: `This file isn't UTF-8 text, so saving it here would change its characters.` }]);
        expect(readFileSync(join(dir, `latin1.txt`))).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
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

    it(`lets a read-only window write nothing, and read everything`, async () => {
        const refused = await ask(`/workspace/upload?path=notes.txt`, { method: `POST`, token: READ_ONLY_TOKEN, body: `x` });
        expect([refused.status, await refused.json()]).toEqual([403, { error: `This window was opened read-only.` }]);
        expect(await (await ask(`/workspace/file?path=notes.txt`, { token: READ_ONLY_TOKEN })).json()).toMatchObject({ present: true, content: `notes` });
        expect(readFileSync(join(dir, `notes.txt`), `utf8`)).toBe(`notes`);
    });
});

// The hello a stream opens with, read off its first `event: message`; the stream is let go once it has arrived.
const helloOf = async (response: Response): Promise<Hello> => {
    if (response.body === null) {
        throw new Error(`the event stream answered without a body`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = ``;
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
        text += decoder.decode(read.value, { stream: true });
        if (text.includes(`\n\n`)) {
            break;
        }
    }
    await reader.cancel();
    return HelloSchema.parse(JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? `null`));
};

// A request that lands on `route` and nothing else: each `{param}` and a trailing `/*` filled in, an `ALL` asked as GET.
const probeOf = (route: ContractRoute) => ({
    method: route.method === `ALL` ? `GET` : route.method,
    path: route.path.replaceAll(/\{[^}]+\}/g, `probe`).replace(/\/\*$/, `/probe`),
});

describe(`what a window's hello says it serves`, () => {
    // Read from outside: a route is served when asking for it gets any answer but the router's own "doesn't serve", a
    // refusal of the probe's made-up input included. A route another one shadows for every request is not probed.
    it(`lists exactly the routes the window answers, and names the surface a folder`, async () => {
        const events = new AbortController();
        const hello = await helloOf(await ask(`/events`, { token: FOLDER_TOKEN, signal: events.signal }));
        events.abort();
        const probed = [...SANDBOX_ROUTES, ...RAW_ROUTE_LIST].filter((route) => sandboxRouteFor(probeOf(route).method, probeOf(route).path)?.name === route.name);
        const answers = await Promise.all(
            probed.map(async (route) => {
                const stop = new AbortController();
                const answer = await ask(probeOf(route).path, { method: probeOf(route).method, token: FOLDER_TOKEN, signal: stop.signal });
                const unserved = answer.status === 404 && (await answer.text()).includes(`This folder view doesn't serve`);
                stop.abort();
                return unserved ? [] : [route.name];
            }),
        );
        expect(hello).toMatchObject({ kind: `hello`, workspaceId: `local-w1`, surface: `folder` });
        expect(hello.routes).toEqual(answers.flat().toSorted());
    });

    // Served, so each answers its refusal, but never offered: the editor shows no Delete it would only be refused.
    it(`leaves out of a document's and a read-only window's hello the verbs they would only refuse`, async () => {
        const routesOf = async (token: string): Promise<readonly string[]> => {
            const stop = new AbortController();
            const hello = await helloOf(await ask(`/events`, { token, signal: stop.signal }));
            stop.abort();
            return hello.routes ?? [];
        };
        const verbs = [`workspace.copy`, `workspace.delete`, `workspace.mkdir`, `workspace.move`];
        const folder = await routesOf(FOLDER_TOKEN);
        expect(verbs.filter((verb) => folder.includes(verb))).toEqual(verbs);
        expect(await routesOf(FILE_TOKEN)).toEqual(folder.filter((route) => !verbs.includes(route)));
        expect(await routesOf(READ_ONLY_TOKEN)).toEqual(folder.filter((route) => !verbs.includes(route) && route !== `POST /workspace/upload`));
    });
});

// A derive, a trash ask or a large copy outlasts a connection's idle bound: the process lifts it for those alone.
describe(`unhurried`, () => {
    it(`names the routes that wait on long work, and no other`, () => {
        const routes: [string, string][] = [
            [`POST`, `/workspace/derive`],
            [`DELETE`, `/workspace/entry`],
            [`POST`, `/workspace/copy`],
            [`GET`, `/workspace/tree`],
            [`POST`, `/workspace/upload`],
            [`GET`, `/events`],
        ];
        expect(routes.map(([method, path]) => unhurried(new Request(`http://127.0.0.1:${PORT}${path}`, { method })))).toEqual([true, true, true, false, false, false]);
    });
});
