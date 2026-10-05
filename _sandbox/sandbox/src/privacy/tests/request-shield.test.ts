import { PRIVACY_REPLACEMENTS_MAX } from "@intentic/sandbox-contract";
import sharp from "sharp";
import type { OcrLine } from "../../ocr/paddle-ocr.js";
import { createMaskMemo, createMasker } from "../masker.js";
import { privacySliceFake } from "../privacy-slice.testing.js";
import type { ImageReading, LocalReaders } from "../readers.js";
import { tokenOf } from "../tokens.js";
import { createReadingMemo, emptyTally, maskingShield, watchingShield } from "../gateway/request-shield.js";
import type { ShieldBinary } from "../gateway/shield-types.js";

// What an image or a PDF bound for an untrusted provider becomes: masked, an image goes with what the reader finds in
// it painted over; one that cannot be read is held back rather than sent unchecked; allowed, it goes as it is. A PDF
// goes as its masked text.

const PESEL = "44051401458";
const PDF = Buffer.from("%PDF-1.7 fake").toString("base64");
const NATIONAL_ID_1 = tokenOf("NATIONAL_ID", 1);
// What the log keeps of the number read off the page: its token, and the line as the painted picture reads.
const IMAGE_REPLACEMENT = { token: NATIONAL_ID_1, class: "national-id" as const, excerpt: `PESEL ${NATIONAL_ID_1}`, image: true };

// A grey page 200 x 40 with one line of text across it, as the reader would report it: "PESEL <number>", each character
// an equal share of the line's width.
const WIDTH = 200;
const HEIGHT = 40;
const GREY = 128;
const page = async (): Promise<string> =>
    (await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: { r: GREY, g: GREY, b: GREY } } }).png().toBuffer()).toString("base64");

const lineOf = (text: string): OcrLine => {
    const chars = [...text];
    return {
        text,
        score: 0.99,
        corners: [
            { x: 0, y: 10 },
            { x: WIDTH, y: 10 },
            { x: WIDTH, y: 30 },
            { x: 0, y: 30 },
        ],
        chars: chars.map((char, index) => ({ char, from: index / chars.length, to: (index + 1) / chars.length })),
        column: 1 / chars.length,
        vertical: false,
    };
};

const readers = (text: string | undefined): LocalReaders & { reads: number } => {
    const reader = {
        reads: 0,
        ocr: async () => text !== undefined,
        readImage: async (): Promise<ImageReading | undefined> => {
            reader.reads += 1;
            return text === undefined ? undefined : { width: WIDTH, height: HEIGHT, lines: text === "" ? [] : [lineOf(text)] };
        },
        readPdf: async () => {
            reader.reads += 1;
            return text;
        },
    };
    return reader;
};

const shieldWith = (images: "mask" | "allow", reader: LocalReaders, fetchImage?: (url: string) => Promise<ShieldBinary | undefined>) => {
    const { privacyShield } = privacySliceFake();
    const masker = createMasker({
        vault: privacyShield.vault,
        policy: { classes: ["national-id"], allow: [], names: "dictionary" },
        memo: createMaskMemo(),
    });
    const tally = emptyTally();
    const readings = createReadingMemo();
    return { tally, shield: maskingShield({ masker, readers: reader, readings, images, tally, ...(fetchImage === undefined ? {} : { fetchImage }) }) };
};

// The shade of the painted image at one point: what the reader's line held there is either still grey or covered.
const shadeAt = async (image: ShieldBinary, x: number, y: number): Promise<number> => {
    const { data, info } = await sharp(Buffer.from(image.data, "base64")).raw().toBuffer({ resolveWithObject: true });
    return data[(y * info.width + x) * info.channels] ?? -1;
};

test("masked, an image goes as the same picture with the value painted over and its label left", async () => {
    const reader = readers(`PESEL ${PESEL}`);
    const { shield, tally } = shieldWith("mask", reader);
    const out = await shield.image({ mediaType: "image/png", data: await page() });
    if (typeof out === "string" || !("image" in out)) {
        throw new Error(`expected a painted image, got ${JSON.stringify(out)}`);
    }
    expect(out.image.mediaType).toBe("image/png");
    // "PESEL " is the first sixth of the line and stays; the number's stretch is covered in white.
    expect(await shadeAt(out.image, 10, 20)).toBe(GREY);
    expect(await shadeAt(out.image, 150, 11)).toBe(255);
    expect(tally).toEqual({ counts: { "national-id": 1 }, images: 1, documents: 0, replacements: [IMAGE_REPLACEMENT] });
});

test("the same image, re-sent, is read once and goes as the same bytes, counted once", async () => {
    const reader = readers(`PESEL ${PESEL}`);
    const { shield, tally } = shieldWith("mask", reader);
    const image = { mediaType: "image/png", data: await page() };
    const first = await shield.image(image);
    const second = await shield.image(image);
    expect(second).toEqual(first);
    expect(reader.reads).toBe(1);
    expect(tally).toEqual({ counts: { "national-id": 1 }, images: 1, documents: 0, replacements: [IMAGE_REPLACEMENT] });
});

test("an image with nothing personal on it goes as it is", async () => {
    const { shield, tally } = shieldWith("mask", readers("Faktura nr 12/2026"));
    expect(await shield.image({ mediaType: "image/png", data: await page() })).toBe("keep");
    const { shield: blank } = shieldWith("mask", readers(""));
    expect(await blank.image({ mediaType: "image/png", data: await page() })).toBe("keep");
    expect(tally).toEqual({ counts: {}, images: 0, documents: 0, replacements: [] });
});

test("an image that cannot be read is held back rather than sent unchecked", async () => {
    const { shield, tally } = shieldWith("mask", readers(undefined));
    expect(JSON.stringify(await shield.image({ mediaType: "image/png", data: await page() }))).toContain("withheld");
    expect(tally.images).toBe(1);
});

test("an image named by its address is fetched, checked, and goes inline; one that will not fetch is held back", async () => {
    const fetched = { mediaType: "image/png", data: await page() };
    const asked: string[] = [];
    const { shield } = shieldWith("mask", readers("Faktura nr 12/2026"), async (url) => {
        asked.push(url);
        return fetched;
    });
    expect(await shield.image({ mediaType: "url", data: "https://example.com/scan.png" })).toEqual({ image: fetched });
    expect(asked).toEqual(["https://example.com/scan.png"]);
    const { shield: offline } = shieldWith("mask", readers("anything"), async () => undefined);
    expect(JSON.stringify(await offline.image({ mediaType: "url", data: "https://example.com/scan.png" }))).toContain("withheld");
});

test("allowed, an image goes as it is, is never read and counts for nothing", async () => {
    const reader = readers(`PESEL ${PESEL}`);
    const { shield, tally } = shieldWith("allow", reader);
    expect(await shield.image({ mediaType: "image/png", data: await page() })).toBe("keep");
    expect(reader.reads).toBe(0);
    expect(tally.images).toBe(0);
});

test("a PDF goes as its masked text; one that yields none, or is not a PDF, is withheld", async () => {
    const { shield, tally } = shieldWith("mask", readers(`Umowa z PESEL ${PESEL}`));
    const out = await shield.document({ mediaType: "application/pdf", data: PDF });
    expect(JSON.stringify(out)).toContain(NATIONAL_ID_1);
    expect(JSON.stringify(out)).not.toContain(PESEL);
    expect(tally.documents).toBe(1);
    expect(tally.replacements).toEqual([{ token: NATIONAL_ID_1, class: "national-id", excerpt: `Umowa z PESEL ${NATIONAL_ID_1}` }]);
    const { shield: blank } = shieldWith("mask", readers(undefined));
    expect(JSON.stringify(await blank.document({ mediaType: "application/pdf", data: PDF }))).toContain("withheld");
    expect(JSON.stringify(await blank.document({ mediaType: "application/msword", data: PDF }))).toContain("withheld");
});

test("watching counts what masking would have checked and changes nothing", async () => {
    const { privacyShield } = privacySliceFake();
    const masker = createMasker({
        vault: privacyShield.vault,
        policy: { classes: ["national-id"], allow: [], names: "dictionary" },
        memo: createMaskMemo(),
    });
    const tally = emptyTally();
    const shield = watchingShield({ masker, tally, images: "mask" });
    expect(await shield.mask(`PESEL ${PESEL}`)).toBe(`PESEL ${PESEL}`);
    expect(await shield.image({ mediaType: "image/png", data: await page() })).toBe("keep");
    expect(shield.note).toBeUndefined();
    // What it would have become is recorded all the same, which is what lets the owner judge before masking.
    expect(tally).toEqual({
        counts: { "national-id": 1 },
        images: 1,
        documents: 0,
        replacements: [{ token: NATIONAL_ID_1, class: "national-id", excerpt: `PESEL ${NATIONAL_ID_1}` }],
    });
});

test("a request keeps the first of each token for the log, and no more than the log's share", async () => {
    const { privacyShield } = privacySliceFake();
    const masker = createMasker({
        vault: privacyShield.vault,
        policy: { classes: ["email"], allow: [], names: "dictionary" },
        memo: createMaskMemo(),
    });
    const tally = emptyTally();
    const shield = maskingShield({ masker, readers: readers(undefined), readings: createReadingMemo(), images: "mask", tally });
    await shield.mask("write to first@acme-legal.pl");
    await shield.mask("again first@acme-legal.pl, and then the rest");
    for (let index = 0; index < PRIVACY_REPLACEMENTS_MAX + 3; index += 1) {
        await shield.mask(`copy to person${index}@acme-legal.pl`);
    }
    expect(tally.counts.email).toBe(PRIVACY_REPLACEMENTS_MAX + 5);
    expect(tally.replacements).toHaveLength(PRIVACY_REPLACEMENTS_MAX);
    expect(new Set(tally.replacements.map((each) => each.token)).size).toBe(PRIVACY_REPLACEMENTS_MAX);
    expect(tally.replacements[0]).toEqual({ token: tokenOf("EMAIL", 1), class: "email", excerpt: `write to ${tokenOf("EMAIL", 1)}` });
});
