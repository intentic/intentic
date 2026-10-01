import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gunzipSync } from "node:zlib";
import { serveStatic, type StaticRoot } from "../static-files.js";

// The editor's static files over real HTTP against a temp tree: what is compressed and how, what is refused, and the
// caching every response carries.

interface Raw {
    readonly status: number;
    readonly headers: http.IncomingHttpHeaders;
    readonly body: Buffer;
}

let dir: string;
let server: http.Server;
let port = 0;
// Which root the next requests are served from.
let root: StaticRoot;

const api = `/* api */ `.repeat(300);
const wasm = Buffer.from(`\0asm wasm module bytes `.repeat(200));
const png = Buffer.alloc(3000, 7);
const font = Buffer.from(`font bytes `.repeat(300));

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), `oo-static-`));
    const files = {
        "web-apps/apps/api/documents/api.js": api,
        "sdkjs/common/wasm/x2t/x2t.wasm.br": brotliCompressSync(wasm),
        "img/icon.png": png,
        "fonts/067": font,
        "themes.json": `{"themes": []}`,
        ".verified": `digest`,
    };
    for (const [path, body] of Object.entries(files)) {
        await mkdir(join(dir, `tree`, path, `..`), { recursive: true });
        await writeFile(join(dir, `tree`, path), body);
    }
    server = http.createServer((req, res) => {
        const url = new URL(req.url ?? `/`, `http://static`);
        serveStatic(req, res, root, decodeURIComponent(url.pathname.slice(1))).catch(() => res.destroy());
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
    root = { dir: join(dir, `tree`), gzipCache: join(dir, `gz`) };
});

// A request with exactly the headers given (fetch would add its own accept-encoding and decode the answer).
const raw = (path: string, headers: Record<string, string> = {}, method = `GET`): Promise<Raw> =>
    new Promise((resolve, reject) => {
        const request = http.request({ host: `127.0.0.1`, port, path, method, headers }, (response) => {
            const chunks: Buffer[] = [];
            response.on(`data`, (chunk: Buffer) => chunks.push(chunk));
            response.on(`end`, () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        request.on(`error`, reject);
        request.end();
    });

describe(`compression`, () => {
    it(`sends a gzip copy to a browser that takes gzip, made once and kept beside the tree`, async () => {
        const first = await raw(`/web-apps/apps/api/documents/api.js`, { "accept-encoding": `gzip, deflate, br` });
        expect(first.status).toBe(200);
        expect(first.headers[`content-encoding`]).toBe(`gzip`);
        expect(first.headers[`content-type`]).toBe(`text/javascript; charset=utf-8`);
        expect(first.headers[`vary`]).toBe(`accept-encoding`);
        expect(gunzipSync(first.body).toString(`utf8`)).toBe(api);
        const kept = await stat(join(dir, `gz`, `web-apps/apps/api/documents/api.js.gz`));
        expect(Number(first.headers[`content-length`])).toBe(kept.size);
        const second = await raw(`/web-apps/apps/api/documents/api.js`, { "accept-encoding": `gzip` });
        expect(second.body.equals(first.body)).toBe(true);
    });

    it(`sends the plain bytes to a browser that takes no gzip`, async () => {
        const plain = await raw(`/web-apps/apps/api/documents/api.js`);
        expect(plain.headers[`content-encoding`]).toBeUndefined();
        expect(plain.body.toString(`utf8`)).toBe(api);
        expect(Number(plain.headers[`content-length`])).toBe(Buffer.byteLength(api));
    });

    it(`compresses the font catalog's extensionless files, and leaves images and small files alone`, async () => {
        const fontAnswer = await raw(`/fonts/067`, { "accept-encoding": `gzip` });
        expect(fontAnswer.headers[`content-encoding`]).toBe(`gzip`);
        expect(gunzipSync(fontAnswer.body).equals(font)).toBe(true);
        const image = await raw(`/img/icon.png`, { "accept-encoding": `gzip` });
        expect(image.headers[`content-encoding`]).toBeUndefined();
        expect(image.headers[`content-type`]).toBe(`image/png`);
        expect(image.body.equals(png)).toBe(true);
        const small = await raw(`/themes.json`, { "accept-encoding": `gzip` });
        expect(small.headers[`content-encoding`]).toBeUndefined();
        expect(small.body.toString(`utf8`)).toBe(`{"themes": []}`);
    });

    it(`compresses on every request for a root with no place to keep copies`, async () => {
        root = { dir: join(dir, `tree`), gzipCache: undefined };
        const answer = await raw(`/web-apps/apps/api/documents/api.js`, { "accept-encoding": `gzip` });
        expect(answer.headers[`content-encoding`]).toBe(`gzip`);
        expect(answer.headers[`content-length`]).toBeUndefined();
        expect(gunzipSync(answer.body).toString(`utf8`)).toBe(api);
    });
});

describe(`the converter, shipped brotli-compressed`, () => {
    it(`goes out as brotli to a browser that takes it`, async () => {
        const answer = await raw(`/sdkjs/common/wasm/x2t/x2t.wasm.br`, { "accept-encoding": `gzip, br` });
        expect(answer.headers[`content-encoding`]).toBe(`br`);
        expect(answer.headers[`content-type`]).toBe(`application/octet-stream`);
        expect(answer.body.equals(await readFile(join(dir, `tree`, `sdkjs/common/wasm/x2t/x2t.wasm.br`)))).toBe(true);
    });

    it(`goes out decoded to one that does not, so it still loads`, async () => {
        const answer = await raw(`/sdkjs/common/wasm/x2t/x2t.wasm.br`, { "accept-encoding": `gzip` });
        expect(answer.headers[`content-encoding`]).toBeUndefined();
        expect(answer.body.equals(wasm)).toBe(true);
    });
});

describe(`every response`, () => {
    it(`is cacheable for good, since the URL names the version`, async () => {
        const answer = await raw(`/img/icon.png`);
        expect(answer.headers[`cache-control`]).toBe(`public, max-age=31536000, immutable`);
        expect(answer.headers[`x-content-type-options`]).toBe(`nosniff`);
    });

    it(`answers HEAD with the headers and no body`, async () => {
        const answer = await raw(`/img/icon.png`, {}, `HEAD`);
        expect(answer.status).toBe(200);
        expect(answer.headers[`content-length`]).toBe(String(png.length));
        expect(answer.body.length).toBe(0);
    });
});

describe(`what is refused`, () => {
    it(`404s a path that climbs out, a dotfile, a directory and a file that is not there`, async () => {
        for (const path of [`/../outside.txt`, `/web-apps/../../outside`, `/.verified`, `/web-apps`, `/missing.js`]) {
            expect([path, (await raw(path)).status]).toEqual([path, 404]);
        }
    });
});
