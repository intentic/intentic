import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tarGzOf, type TarFixtureEntry } from "../../testing.js";
import type { BundlePin } from "../bundle-pin.js";
import { BundleStore, keptPath, treeDigest } from "../bundle.js";

// The bundle store against a temp cache and a scripted download: what reaches the disk, when the tree becomes the one
// served, and what an interrupted, altered or stalled download leaves behind (nothing).

const HELPER = `sdkjs/common/wasm/x2t/x2t_helper.js`;
const helperSource = `before\n        post(top);\nafter\n`;

// The source tree as the archive carries it, the site around the editor included.
const source: TarFixtureEntry[] = [
    { name: `document-abc/`, type: `directory` },
    { name: `document-abc/index.html`, body: `the site around the editor` },
    { name: `document-abc/public/sdkjs/word/sdk-all-min.js`, body: `word sdk` },
    { name: `document-abc/public/sdkjs/common/wasm/x2t/x2t_helper.js`, body: helperSource },
    { name: `document-abc/public/web-apps/apps/api/documents/api.js`, body: `api` },
    { name: `document-abc/public/themes.json`, body: `{"themes": []}` },
    { name: `document-abc/public/themes.json.bak`, body: `not kept: only the exact file is` },
    { name: `document-abc/LICENSE`, body: `AGPL` },
];

// The tree the pin keeps from `source`, by bundle path.
const kept = {
    "sdkjs/word/sdk-all-min.js": `word sdk`,
    [HELPER]: helperSource,
    "web-apps/apps/api/documents/api.js": `api`,
    "themes.json": `{"themes": []}`,
    LICENSE: `AGPL`,
};

const sha = (text: string): string => createHash(`sha256`).update(text).digest(`hex`);

const pinFor = (overrides: Partial<BundlePin> = {}): BundlePin => {
    const pin: BundlePin = {
        id: `test-pin`,
        url: `https://example.test/bundle.tar.gz`,
        approximateBytes: 1,
        stripPrefix: `document-abc/`,
        keep: [
            [`public/sdkjs/`, `sdkjs/`],
            [`public/web-apps/`, `web-apps/`],
            [`public/themes.json`, `themes.json`],
            [`LICENSE`, `LICENSE`],
        ],
        files: Object.keys(kept).length,
        digest: treeDigest(new Map(Object.entries(kept).map(([path, body]) => [path, sha(body)]))),
        patches: [{ file: HELPER, find: `        post(top);\n`, replace: `        // no top\n`, why: `no top` }],
    };
    return { ...pin, ...overrides };
};

let root: string;
const logged: string[] = [];

beforeEach(async () => {
    root = join(await mkdtemp(join(tmpdir(), `oo-bundle-`)), `bundle`);
    logged.length = 0;
});

afterEach(async () => {
    await rm(join(root, `..`), { recursive: true, force: true });
});

interface Served {
    readonly fetch: typeof fetch;
    readonly calls: string[];
}

// A download that answers `body` (a stream, so it can also be made to stall).
const serving = (body: () => ReadableStream<Uint8Array> | null, status = 200): Served => {
    const calls: string[] = [];
    return {
        calls,
        // SAFETY: a stand-in for fetch that reads only the URL it is asked for.
        fetch: (async (input: string | URL | Request) => {
            calls.push(String(input));
            return new Response(body(), { status });
        }) as typeof fetch,
    };
};

const bytes =
    (buffer: Buffer): (() => ReadableStream<Uint8Array>) =>
    () =>
        new Blob([new Uint8Array(buffer)]).stream();

const store = (pin: BundlePin, served: Served, stallMs?: number): BundleStore =>
    new BundleStore({ root, pin, fetch: served.fetch, log: (line) => logged.push(line), stallMs });

const treeOn = async (dir: string): Promise<string[]> =>
    (await readdir(dir, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
        .sort();

describe(`downloading the pinned bundle`, () => {
    it(`keeps only the pinned files, verifies them, patches them, and only then serves the tree`, async () => {
        const served = serving(bytes(tarGzOf(source)));
        const bundles = store(pinFor(), served);
        expect(await bundles.load()).toEqual({ state: `absent` });
        expect(await bundles.ensure()).toEqual({ state: `downloading`, percent: 0 });
        expect(await bundles.settled()).toEqual({ state: `ready`, dir: join(root, `test-pin`) });
        expect(await treeOn(join(root, `test-pin`))).toEqual([`.verified`, ...Object.keys(kept)].sort());
        expect(await readFile(join(root, `test-pin`, HELPER), `utf8`)).toBe(`before\n        // no top\nafter\n`);
        expect(await readdir(root)).toEqual([`test-pin`]);
        expect(served.calls).toEqual([`https://example.test/bundle.tar.gz`]);
    });

    it(`starts one download however many opens ask for it at once`, async () => {
        const served = serving(bytes(tarGzOf(source)));
        const bundles = store(pinFor(), served);
        await Promise.all([bundles.ensure(), bundles.ensure(), bundles.ensure()]);
        expect((await bundles.settled()).state).toBe(`ready`);
        await bundles.ensure();
        expect(served.calls).toHaveLength(1);
    });

    it(`finds a verified tree ready at the next start, and clears out other pins and an interrupted download`, async () => {
        const first = store(pinFor(), serving(bytes(tarGzOf(source))));
        await first.ensure();
        await first.settled();
        await mkdir(join(root, `old-pin`, `sdkjs`), { recursive: true });
        await mkdir(join(root, `test-pin.partial`), { recursive: true });
        const served = serving(() => null);
        const restarted = store(pinFor(), served);
        expect(await restarted.load()).toEqual({ state: `ready`, dir: join(root, `test-pin`) });
        expect(await readdir(root)).toEqual([`test-pin`]);
        expect(served.calls).toEqual([]);
    });
});

describe(`a download that cannot be trusted`, () => {
    it(`fails on files that do not match the pin, and leaves nothing to serve`, async () => {
        const altered = source.map((entry) => (entry.name.endsWith(`api.js`) ? { ...entry, body: `api, altered` } : entry));
        const bundles = store(pinFor(), serving(bytes(tarGzOf(altered))));
        await bundles.ensure();
        expect(await bundles.settled()).toEqual({
            state: `failed`,
            detail: `The editor could not be downloaded: the downloaded files do not match the pinned bundle (5 of 5 files).`,
        });
        expect(await readdir(root)).toEqual([]);
    });

    it(`never writes an entry whose path climbs out of the tree`, async () => {
        const climbing = [...source, { name: `document-abc/public/sdkjs/../../../escaped.txt`, body: `out` }];
        const bundles = store(pinFor(), serving(bytes(tarGzOf(climbing))));
        await bundles.ensure();
        expect((await bundles.settled()).state).toBe(`ready`);
        expect(await readdir(join(root, `..`))).toEqual([`bundle`]);
        expect(keptPath(pinFor(), `document-abc/public/sdkjs/../../../escaped.txt`)).toBeUndefined();
    });

    it(`fails a pin whose patch no longer finds its text, rather than serving the file unpatched`, async () => {
        const pin = pinFor({ patches: [{ file: HELPER, find: `absent\n`, replace: ``, why: `gone` }] });
        const bundles = store(pin, serving(bytes(tarGzOf(source))));
        await bundles.ensure();
        expect(await bundles.settled()).toEqual({
            state: `failed`,
            detail: `The editor could not be downloaded: the editor bundle's ${HELPER} no longer reads as its patch expects (gone).`,
        });
        expect(await readdir(root)).toEqual([]);
    });

    it(`fails on an HTTP error, and tries again on the next ensure`, async () => {
        let status = 503;
        const calls: string[] = [];
        // SAFETY: a stand-in for fetch that reads only the URL it is asked for.
        const flaky = (async (input: string | URL | Request) => {
            calls.push(String(input));
            return new Response(status === 200 ? bytes(tarGzOf(source))() : null, { status });
        }) as typeof fetch;
        const bundles = new BundleStore({ root, pin: pinFor(), fetch: flaky, log: (line) => logged.push(line) });
        await bundles.ensure();
        expect(await bundles.settled()).toEqual({ state: `failed`, detail: `The editor could not be downloaded: the download answered 503.` });
        status = 200;
        await bundles.ensure();
        expect((await bundles.settled()).state).toBe(`ready`);
        expect(calls).toHaveLength(2);
    });

    it(`fails a download that stops sending, instead of spinning forever`, async () => {
        const archive = tarGzOf(source);
        // Half the archive, then silence with the connection held open.
        const stalling = (): ReadableStream<Uint8Array> =>
            new ReadableStream({
                start: (controller) => controller.enqueue(new Uint8Array(archive.subarray(0, archive.length >> 1))),
            });
        const bundles = store(pinFor(), serving(stalling), 50);
        await bundles.ensure();
        expect(await bundles.settled()).toEqual({ state: `failed`, detail: `The editor could not be downloaded: the download stalled.` });
        expect(await readdir(root)).toEqual([]);
    });
});

describe(`a partial tree on disk`, () => {
    it(`is not taken for a finished one: without its marker the tree is removed and fetched again`, async () => {
        await mkdir(join(root, `test-pin`, `sdkjs`), { recursive: true });
        await writeFile(join(root, `test-pin`, `sdkjs`, `half.js`), `half`);
        const served = serving(bytes(tarGzOf(source)));
        const bundles = store(pinFor(), served);
        expect(await bundles.load()).toEqual({ state: `absent` });
        await bundles.ensure();
        expect((await bundles.settled()).state).toBe(`ready`);
        expect(await treeOn(join(root, `test-pin`))).not.toContain(`sdkjs/half.js`);
    });
});
