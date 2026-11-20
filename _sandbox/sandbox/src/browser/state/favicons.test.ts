import { FAVICON_MAX_BYTES, FaviconCache, dibToRgba, encodePng, iconDataUrl, pickIcoEntry, sniffImage } from "./favicons.js";

// A solid square of one colour as PNG bytes.
const square = (size: number, rgba: readonly number[] = [255, 0, 0, 255]): Buffer =>
    encodePng(size, size, Uint8Array.from({ length: size * size * 4 }, (_, index) => rgba[index % 4] ?? 0));

// An .ico holding each picture under its size, as a browser serves /favicon.ico.
const ico = (pictures: readonly { readonly size: number; readonly bits?: number; readonly bytes: Buffer }[]): Buffer => {
    const header = Buffer.alloc(6 + pictures.length * 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(pictures.length, 4);
    let offset = header.length;
    for (const [index, picture] of pictures.entries()) {
        const at = 6 + index * 16;
        header.writeUInt8(picture.size === 256 ? 0 : picture.size, at);
        header.writeUInt8(picture.size === 256 ? 0 : picture.size, at + 1);
        header.writeUInt16LE(picture.bits ?? 32, at + 6);
        header.writeUInt32LE(picture.bytes.length, at + 8);
        header.writeUInt32LE(offset, at + 12);
        offset += picture.bytes.length;
    }
    return Buffer.concat([header, ...pictures.map((picture) => picture.bytes)]);
};

// A bitmap picture as an .ico holds one: a BITMAPINFOHEADER at twice the height, the colour rows bottom first, then
// the one-bit mask rows, each padded to four bytes.
const dib = (width: number, height: number, bits: 24 | 32, pixelsBottomUp: readonly number[][], maskBottomUp: readonly number[]): Buffer => {
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(width, 4);
    header.writeInt32LE(height * 2, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(bits, 14);
    const stride = Math.ceil((width * bits) / 32) * 4;
    const rows = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            Buffer.from(pixelsBottomUp[y * width + x] ?? []).copy(rows, y * stride + x * (bits / 8));
        }
    }
    const mask = Buffer.alloc(4 * height);
    for (const [y, row] of maskBottomUp.entries()) {
        mask.writeUInt8(row, y * 4);
    }
    return Buffer.concat([header, rows, mask]);
};

const decoded = (url: string | undefined): Buffer => Buffer.from(url?.split(",")[1] ?? "", "base64");

describe("a tab's icon, from what its address answered", () => {
    test("an image is known by its own first bytes, whatever the server called it", () => {
        expect(sniffImage(square(1))).toBe("png");
        expect(sniffImage(Buffer.from("GIF89a"))).toBe("gif");
        expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
        expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
        expect(sniffImage(ico([{ size: 16, bytes: square(16) }]))).toBe("ico");
        expect(sniffImage(Buffer.from(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>`))).toBe("svg");
        // A 404 page served at /favicon.ico is no icon.
        expect(sniffImage(Buffer.from("<!doctype html><title>Not found</title>"))).toBeUndefined();
    });

    test("a small image goes as it is, inline, under its own type", () => {
        const png = square(16);
        expect(iconDataUrl(png)).toBe(`data:image/png;base64,${png.toString("base64")}`);
        const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>`);
        expect(iconDataUrl(svg)).toBe(`data:image/svg+xml;base64,${svg.toString("base64")}`);
    });

    test("anything over the cap is no icon at all, never a larger state", () => {
        // Noise does not compress: a 64-pixel square of it is well over four kilobytes as PNG.
        let seed = 12_345;
        const noise = (): number => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed >> 16;
        };
        const noisy = encodePng(64, 64, Uint8Array.from({ length: 64 * 64 * 4 }, () => noise() % 256));
        expect(noisy.length).toBeGreaterThan(FAVICON_MAX_BYTES);
        expect(iconDataUrl(noisy)).toBeUndefined();
        expect(iconDataUrl(square(16), 10)).toBeUndefined();
        expect(iconDataUrl(Buffer.from("<html></html>"))).toBeUndefined();
        expect(iconDataUrl(new Uint8Array())).toBeUndefined();
    });

    test("a multi-size .ico gives up its 32-pixel picture, the strip's 16 at twice the density", () => {
        expect(pickIcoEntry([{ size: 16, bits: 32 }, { size: 32, bits: 32 }, { size: 48, bits: 32 }])).toEqual({ size: 32, bits: 32 });
        // No 32: the smallest larger one, else the largest smaller; more colours among equals.
        expect(pickIcoEntry([{ size: 16, bits: 32 }, { size: 64, bits: 32 }, { size: 256, bits: 32 }])).toEqual({ size: 64, bits: 32 });
        expect(pickIcoEntry([{ size: 16, bits: 8 }, { size: 16, bits: 32 }, { size: 24, bits: 32 }])).toEqual({ size: 24, bits: 32 });
        expect(pickIcoEntry([])).toBeUndefined();

        const wanted = square(32, [0, 0, 255, 255]);
        const file = ico([
            { size: 16, bytes: square(16) },
            { size: 32, bytes: wanted },
            { size: 256, bytes: square(256) },
        ]);
        expect(decoded(iconDataUrl(file))).toEqual(wanted);
        expect(iconDataUrl(file)?.startsWith("data:image/png;base64,")).toBe(true);
    });

    test("a bitmap picture in an .ico is drawn the right way up, see-through where its mask says", () => {
        // Bottom row first: blue, green; top row: red, white. The mask hides the top-left pixel (bit 7 of the top row,
        // which is the file's last mask row).
        const blue = [255, 0, 0];
        const green = [0, 255, 0];
        const red = [0, 0, 255];
        const white = [255, 255, 255];
        const picture = dibToRgba(dib(2, 2, 24, [blue, green, red, white], [0, 0b1000_0000]));
        expect(picture).toMatchObject({ width: 2, height: 2 });
        expect([...(picture?.rgba ?? [])]).toEqual([255, 0, 0, 0, 255, 255, 255, 255, 0, 0, 255, 255, 0, 255, 0, 255]);
    });

    test("a 32-bit picture keeps its own alpha, unless it has none, when its mask stands in", () => {
        const own = dibToRgba(dib(1, 1, 32, [[10, 20, 30, 128]], [0b1000_0000]));
        expect([...(own?.rgba ?? [])]).toEqual([30, 20, 10, 128]);
        const maskOnly = dibToRgba(dib(2, 1, 32, [[10, 20, 30, 0], [40, 50, 60, 0]], [0b0100_0000]));
        expect([...(maskOnly?.rgba ?? [])]).toEqual([30, 20, 10, 255, 60, 50, 40, 0]);
    });

    test("an .ico whose only picture is a bitmap is sent as the PNG of it", () => {
        const file = ico([{ size: 1, bytes: dib(1, 1, 32, [[0, 0, 255, 255]], [0]) }]);
        const url = iconDataUrl(file);
        expect(url?.startsWith("data:image/png;base64,")).toBe(true);
        expect(decoded(url)).toEqual(encodePng(1, 1, Uint8Array.from([255, 0, 0, 255])));
    });

    test("a bitmap this cannot read (compressed, too large, cut short) is no icon", () => {
        const compressed = dib(1, 1, 32, [[0, 0, 0, 255]], [0]);
        compressed.writeUInt32LE(1, 16);
        expect(dibToRgba(compressed)).toBeUndefined();
        expect(dibToRgba(Buffer.alloc(12))).toBeUndefined();
        expect(dibToRgba(dib(1, 1, 32, [[0, 0, 0, 255]], [0]).subarray(0, 41))).toBeUndefined();
    });
});

describe("icons held by the address they came from", () => {
    test("one fetch answers every tab asking at once, and later asks too", async () => {
        const cache = new FaviconCache();
        let fetches = 0;
        const fetchIcon = async (): Promise<Uint8Array> => {
            fetches += 1;
            return square(16);
        };
        const [first, second] = await Promise.all([cache.get("https://a.test/favicon.ico", fetchIcon), cache.get("https://a.test/favicon.ico", fetchIcon)]);
        expect(first).toBe(`data:image/png;base64,${square(16).toString("base64")}`);
        expect(second).toBe(first);
        expect(await cache.get("https://a.test/favicon.ico", fetchIcon)).toBe(first);
        expect(fetches).toBe(1);
    });

    test("an address with no icon is asked again only once its miss has gone stale", async () => {
        let now = 1_000_000;
        const cache = new FaviconCache(10, () => now);
        let fetches = 0;
        const fetchIcon = async (): Promise<Uint8Array | undefined> => {
            fetches += 1;
            return undefined;
        };
        expect(await cache.get("https://b.test/favicon.ico", fetchIcon)).toBeUndefined();
        now += 9 * 60_000;
        expect(await cache.get("https://b.test/favicon.ico", fetchIcon)).toBeUndefined();
        expect(fetches).toBe(1);
        now += 2 * 60_000;
        await cache.get("https://b.test/favicon.ico", fetchIcon);
        expect(fetches).toBe(2);
        // A fetch that throws is a miss too, not a rejection.
        expect(await cache.get("https://c.test/favicon.ico", () => Promise.reject(new Error("net::ERR_FAILED")))).toBeUndefined();
    });

    test("past its limit the least recently used icon goes first", async () => {
        const cache = new FaviconCache(2);
        const fetched: string[] = [];
        const fetchIcon = async (url: string): Promise<Uint8Array> => {
            fetched.push(url);
            return square(16);
        };
        await cache.get("a", fetchIcon);
        await cache.get("b", fetchIcon);
        await cache.get("a", fetchIcon);
        await cache.get("c", fetchIcon);
        expect(cache.size).toBe(2);
        await cache.get("a", fetchIcon);
        await cache.get("b", fetchIcon);
        expect(fetched).toEqual(["a", "b", "c", "b"]);
    });
});
