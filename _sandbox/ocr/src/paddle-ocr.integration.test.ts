import sharp from "sharp";
import { requires } from "@intentic/testing/requires";
import { ocrInstalled, ocrModelDir } from "./models.js";
import { type LoadedTextReader, loadTextReader, pageText } from "./paddle-ocr.js";
import { decodeImage } from "./raster.js";

// The reader against the real PP-OCRv6 models, where they are (the privacy pack, and the CI image): what it costs the
// process that asks, and what it reads off pictures drawn here.

const ocr = requires(ocrInstalled(), `the PP-OCRv6 models at ${ocrModelDir()} (the privacy image pack)`);

const LINE = "Faktura 4815162342 z dnia 12.03.2026";

// A photo's worth of pixels: a mottled background, as a camera gives, with one line of dark text on it.
const photo = async (width: number, height: number): Promise<Buffer> => {
    const grain = { width: Math.ceil(width / 16), height: Math.ceil(height / 16), channels: 3 as const };
    const noise = Buffer.alloc(grain.width * grain.height * 3);
    for (let index = 0; index < noise.length; index += 1) {
        noise[index] = 170 + ((index * 7919) % 61);
    }
    const background = await sharp(noise, { raw: grain }).resize(width, height).png().toBuffer();
    const size = Math.round(height / 30);
    const text = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${width / 8}" y="${height / 3}" font-family="DejaVu Sans, sans-serif" font-size="${size}" fill="#111">${LINE}</text></svg>`;
    return sharp(background)
        .composite([{ input: Buffer.from(text) }])
        .png()
        .toBuffer();
};

// The longest the event loop went without turning while `work` ran, measured by a 10 ms timer.
const longestStall = async <T>(work: () => Promise<T>): Promise<{ readonly stallMs: number; readonly value: T }> => {
    let last = performance.now();
    let longest = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
    }, 10);
    try {
        const value = await work();
        return { stallMs: Math.max(longest, performance.now() - last), value };
    } finally {
        clearInterval(timer);
    }
};

let reader: LoadedTextReader | undefined;
beforeAll(async () => {
    reader = ocr.runs ? await loadTextReader() : undefined;
});
// Its model sessions are native memory the process would otherwise hold to the end of the run.
afterAll(async () => {
    await reader?.release();
});

// Measured before the reader ran on a thread of its own: a 4000 x 3000 photo held the caller's event loop for 32 s, a
// 1920 x 1080 screenshot for 2 s, and in the daemon that is every conversation, the editor and its sockets at once.
test.skipIf(!ocr.runs)(ocr.title("reading a phone photo never holds the caller's event loop for more than a moment"), async () => {
    const image = await decodeImage(await photo(4000, 3000));
    const loaded = reader;
    if (image === undefined || loaded === undefined) {
        throw new Error("the photo did not decode, or the reader did not load");
    }
    const { stallMs, value: lines } = await longestStall(() => loaded.read(image.rgba));
    // The text is still read where it is: running elsewhere must not cost what is found.
    expect(pageText(lines)).toContain("4815162342");
    // A copy of the pixels and a message each way is all the caller pays. Measured with the reader on its own thread,
    // node (the daemon) paused 0.2 s at most; bun, which runs this suite, up to 2 s on a machine loaded past its cores.
    expect(stallMs).toBeLessThan(5000);
}, 180_000);

// A page on its head with no orientation tag to say so, as a scanner or a phone can leave it: read the right way up,
// the reader found a few characters of nothing in it, and the shield sent it as it was.
test.skipIf(!ocr.runs)(ocr.title("a page upside down is read, its lines placed where they are on the picture"), async () => {
    const width = 1200;
    const height = 500;
    const lines = ["Klient numer 4815162342", "Faktura z dnia 12.03.2026", "Razem do zaplaty 120,00"];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${lines
        .map((text, index) => `<text x="60" y="${90 + index * 70}" font-family="DejaVu Sans, sans-serif" font-size="40" fill="#111">${text}</text>`)
        .join("")}</svg>`;
    const upright = await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
        .composite([{ input: Buffer.from(svg) }])
        .png()
        .toBuffer();
    // Turned in a pipeline of its own: in one, sharp turns the blank page before it draws on it.
    const page = await sharp(upright)
        .rotate(180)
        .png()
        .toBuffer();
    const image = await decodeImage(page);
    if (image === undefined || reader === undefined) {
        throw new Error("the page did not decode, or the reader did not load");
    }
    const read = await reader.read(image.rgba);
    expect(pageText(read)).toContain("4815162342");
    // Drawn in the page's upper left, so turned over it sits in the picture's lower right.
    const found = read.find((line) => line.text.includes("4815162342"));
    expect(Math.min(...(found?.corners.map((point) => point.y) ?? [0]))).toBeGreaterThan(height / 2);
    expect(Math.min(...(found?.corners.map((point) => point.x) ?? [0]))).toBeGreaterThan(width / 4);
}, 180_000);
