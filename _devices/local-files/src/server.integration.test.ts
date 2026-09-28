import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContractRoute, type Hello, HelloSchema, RAW_ROUTE_LIST, SANDBOX_ROUTES, sandboxRouteFor } from "@intentic/sandbox-contract";
import { sha256Text } from "./files.js";
import { type Grant, Grants } from "./grants.js";
import { APP, type Ask, askerOf, localServer, PORT } from "./testing.js";

// The HTTP face, driven the way the editor drives it, over a real folder: the three gates first, then what each grant
// may read and write.

const FOLDER_TOKEN = `f`.repeat(64);
const FILE_TOKEN = `d`.repeat(64);

let dir: string;
let ask: (path: string, init?: Ask) => Promise<Response>;
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
});
