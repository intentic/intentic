import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { NAMESPACE } from "../../contract.js";
import { BUNDLE_PIN } from "../bundle-pin.js";
import { createLocalOffice, type LocalFolder, type LocalOffice, type OfficePrefetch } from "../local-office.js";

// The desktop app's office backend over a real folder, a bundle already verified in its cache, and the listener it
// opens: a document's original kept by the first save and put back on request, and the editor's download asked for
// before any document is open.

let dir: string;
let work: string;
let office: LocalOffice;
let writable: boolean;
let folder: LocalFolder;
beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), `oo-local-`)));
    work = join(dir, `work`);
    await mkdir(work);
    await writeFile(join(work, `brief.docx`), `original bytes`);
    await mkdir(join(dir, `cache`, `office`, BUNDLE_PIN.id), { recursive: true });
    await writeFile(join(dir, `cache`, `office`, BUNDLE_PIN.id, `.verified`), `${BUNDLE_PIN.digest}\n`);
    await mkdir(join(dir, `page`));
    await writeFile(join(dir, `page`, `editor.js`), `/* page */`);
    office = createLocalOffice({ cacheDir: join(dir, `cache`, `office`), pageDir: join(dir, `page`), log: () => undefined });
    writable = true;
    folder = {
        key: `window-1`,
        root: work,
        resolve: async (path) => {
            // allow(silent-catch): a path with nothing at it resolves to nothing, as the sidecar's own resolver answers.
            const real = await realpath(join(work, path)).catch(() => undefined);
            return real === undefined || relative(work, real).startsWith(`..`) ? undefined : real;
        },
        writable: (path) => writable && path === `brief.docx`,
    };
});
afterEach(async () => {
    await office.close();
    await rm(dir, { recursive: true, force: true });
});

const route = (path: string, init?: RequestInit): Promise<Response | undefined> =>
    office.handle(folder, new Request(`http://127.0.0.1:47001${NAMESPACE}${path}`, init));

const answerOf = async (path: string, init?: RequestInit): Promise<[number | undefined, unknown]> => {
    const answer = await route(path, init);
    return [answer?.status, await answer?.json()];
};

const post = (path: string, body: string): Promise<[number | undefined, unknown]> =>
    answerOf(path, { method: `POST`, body, headers: { "content-type": `application/json` } });

describe(`a document's original`, () => {
    it(`is kept by the first save and put back on request`, async () => {
        expect(await answerOf(`/original?path=brief.docx`)).toEqual([200, { kept: false }]);
        const [status, opened] = await post(`/open`, JSON.stringify({ path: `brief.docx`, mode: `edit`, theme: `light` }));
        expect(status).toBe(200);
        // SAFETY: an open that answered 200 answers the editor page's URL; a body without one fails the parse below.
        const url = new URL((opened as { url: string }).url);
        const file = `${url.origin}/file?s=${url.searchParams.get(`s`) ?? ``}`;
        const etag = (await fetch(file)).headers.get(`etag`) ?? ``;
        expect((await fetch(file, { method: `PUT`, body: `edited bytes`, headers: { "if-match": etag } })).status).toBe(200);
        expect(await readFile(join(work, `brief.docx`), `utf8`)).toBe(`edited bytes`);
        expect(await answerOf(`/original?path=brief.docx`)).toEqual([200, { kept: true, keptAt: expect.any(String) }]);
        expect(await post(`/restore-original`, JSON.stringify({ path: `brief.docx` }))).toEqual([200, { ok: true }]);
        expect(await readFile(join(work, `brief.docx`), `utf8`)).toBe(`original bytes`);
    });

    it(`is not restored where the window may not write, where none is kept, or for a body naming nothing`, async () => {
        expect(await post(`/restore-original`, JSON.stringify({ path: `brief.docx` }))).toEqual([
            404,
            { error: `No original of that document is kept.` },
        ]);
        writable = false;
        expect(await post(`/restore-original`, JSON.stringify({ path: `brief.docx` }))).toEqual([
            403,
            { error: `This window can't change that document.` },
        ]);
        expect(await post(`/restore-original`, `not json`)).toEqual([400, { error: `expected { path }` }]);
        expect(await answerOf(`/original?path=gone.docx`)).toEqual([200, { kept: false }]);
    });
});

// The editor's own address, for every window and every run: its files go out cacheable for a year under it, so the
// browser keeps them, compiled, for the next window and the next start of the app.
describe(`the editor's address`, () => {
    // A second folder of its own, as a second window opens one.
    const other = async (): Promise<LocalFolder> => {
        const root = join(dir, `other`);
        await mkdir(root);
        await writeFile(join(root, `notes.docx`), `other bytes`);
        return { key: `window-2`, root, resolve: async (path) => (path === `notes.docx` ? join(root, path) : undefined), writable: () => true };
    };
    // What `folder` opened `path` at: the editor page's URL, and its document's own address beside it.
    const opened = async (on: LocalFolder, path: string): Promise<{ origin: string; file: string }> => {
        const answer = await office.handle(on, new Request(`http://127.0.0.1:47001${NAMESPACE}/open`, { method: `POST`, body: JSON.stringify({ path, mode: `edit`, theme: `light` }) }));
        if (answer === undefined) {
            throw new Error(`the open was not answered`);
        }
        // SAFETY: an open that answered answers the editor page's URL; a body without one fails the parse below.
        const url = new URL(((await answer.json()) as { url: string }).url);
        return { origin: url.origin, file: `${url.origin}/file?s=${url.searchParams.get(`s`) ?? ``}` };
    };

    it(`is one origin for every folder, each document still read from its own`, async () => {
        const [first, second] = [await opened(folder, `brief.docx`), await opened(await other(), `notes.docx`)];
        expect(second.origin).toBe(first.origin);
        expect(await (await fetch(first.file)).text()).toBe(`original bytes`);
        expect(await (await fetch(second.file)).text()).toBe(`other bytes`);
    });

    it(`ends a closed window's documents and keeps serving the others`, async () => {
        const second = await other();
        const [first, kept] = [await opened(folder, `brief.docx`), await opened(second, `notes.docx`)];
        await office.release(folder.key);
        expect((await fetch(first.file)).status).toBe(404);
        expect(await (await fetch(kept.file)).text()).toBe(`other bytes`);
    });

    it(`is the same after the app starts again`, async () => {
        const before = (await opened(folder, `brief.docx`)).origin;
        await office.close();
        office = createLocalOffice({ cacheDir: join(dir, `cache`, `office`), pageDir: join(dir, `page`), log: () => undefined });
        expect((await opened(folder, `brief.docx`)).origin).toBe(before);
    });
});

describe(`prefetch`, () => {
    it(`answers ready at once when the editor is already here`, async () => {
        expect(await office.prefetch()).toEqual({ state: `ready` });
    });

    // Two asks share one download, and a download that fails says why.
    it(`fetches the editor once however often it is asked, and says why a download failed`, async () => {
        const fetched: string[] = [];
        const empty = createLocalOffice({
            cacheDir: join(dir, `empty-cache`, `office`),
            pageDir: join(dir, `page`),
            log: () => undefined,
            // SAFETY: a stand-in for fetch that reads only the URL it is asked for.
            fetch: (async (input: string | URL | Request) => {
                fetched.push(String(input));
                return new Response(`gone`, { status: 500 });
            }) as typeof fetch,
        });
        const failed: OfficePrefetch = { state: `failed`, error: `The editor could not be downloaded: the download answered 500.` };
        expect(await Promise.all([empty.prefetch(), empty.prefetch()])).toEqual([failed, failed]);
        expect(fetched).toEqual([BUNDLE_PIN.url]);
        await empty.close();
    });
});
