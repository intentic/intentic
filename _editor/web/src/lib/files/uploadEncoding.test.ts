import { Blob as NativeBlob } from "node:buffer";
import { gunzipSync } from "node:zlib";
import { encodedPart, uploadEncoding } from "./uploadEncoding";

/* Which chunks of an upload cross gzipped: text-heavy ones, to a remote daemon that decodes it. */

const remote = { decodes: true, local: false };
const mib = 1024 * 1024;

describe(`uploadEncoding`, () => {
    it(`gzips a chunk of source to a remote daemon that decodes it`, () => {
        expect(uploadEncoding([{ path: `src/index.ts`, size: mib }], remote)).toBe(`gzip`);
    });

    it(`sends plain to a daemon that does not decode, over loopback, or a chunk too small to matter`, () => {
        const files = [{ path: `src/index.ts`, size: mib }];
        expect(uploadEncoding(files, { decodes: false, local: false })).toBeUndefined();
        expect(uploadEncoding(files, { decodes: true, local: true })).toBeUndefined();
        expect(uploadEncoding([{ path: `a.ts`, size: 1024 }], remote)).toBeUndefined();
    });

    it(`sends plain when most of the chunk's bytes are already compressed`, () => {
        const photos = [
            { path: `photos/a.jpg`, size: 3 * mib },
            { path: `photos/b.PNG`, size: 3 * mib },
            { path: `notes.md`, size: mib },
        ];
        expect(uploadEncoding(photos, remote)).toBeUndefined();
        expect(uploadEncoding([...photos, { path: `data.json`, size: 3 * mib }], remote)).toBe(`gzip`);
    });
});

describe(`encodedPart`, () => {
    // The runtime's own Blob, as a browser's is: the DOM test globals' one has no stream().
    const body: Blob = new NativeBlob([`export const value = 1;\n`.repeat(4000)]);

    it(`gzips the part at its offset, and scales progress on the crossing bytes back onto the body's own`, async () => {
        const { part, sent } = await encodedPart(body, 1000, 50_000, `gzip`);
        const decoded = gunzipSync(Buffer.from(await part.arrayBuffer())).toString(`utf8`);
        expect(decoded).toBe(await body.slice(1000, 51_000).text());
        expect(part.size).toBeLessThan(5000);
        expect(sent.offset).toBe(1000);
        expect(Math.round(part.size * sent.scale)).toBe(50_000);
    });

    it(`leaves a part plain when no coding is asked for`, async () => {
        const { part, sent } = await encodedPart(body, 0, 10, undefined);
        expect(await part.text()).toBe(`export con`);
        expect(sent).toEqual({ offset: 0, scale: 1, encoding: undefined });
    });
});
