import { createMaskMemo, createMasker } from "../masker.js";
import { privacySliceFake } from "../privacy-slice.testing.js";
import type { LocalReaders } from "../readers.js";
import { createReadingMemo, emptyTally, maskingShield, watchingShield } from "../gateway/request-shield.js";

// What an image or a PDF bound for an untrusted provider becomes: the owner's choice decides, a reader that is missing
// or reads nothing withholds rather than sends, and what a reader finds is masked like any other text.

const PESEL = "44051401458";
const PNG = Buffer.from("fake png").toString("base64");
const PDF = Buffer.from("%PDF-1.7 fake").toString("base64");

const readers = (text: string | undefined): LocalReaders & { reads: number } => {
    const reader = {
        reads: 0,
        ocr: async () => text !== undefined,
        readImage: async () => {
            reader.reads += 1;
            return text;
        },
        readPdf: async () => {
            reader.reads += 1;
            return text;
        },
    };
    return reader;
};

const shieldWith = (images: "withhold" | "read" | "allow", reader: LocalReaders) => {
    const { privacyShield } = privacySliceFake();
    const masker = createMasker({
        vault: privacyShield.vault,
        policy: { classes: ["national-id"], allow: [], names: "dictionary" },
        memo: createMaskMemo(),
    });
    const tally = emptyTally();
    return { tally, shield: maskingShield({ masker, readers: reader, readings: createReadingMemo(), images, tally }) };
};

test("withheld, an image becomes a note and is never read", async () => {
    const reader = readers(`PESEL ${PESEL}`);
    const { shield, tally } = shieldWith("withhold", reader);
    const out = await shield.image({ mediaType: "image/png", data: PNG });
    expect(JSON.stringify(out)).toContain("withheld by the privacy shield");
    expect(reader.reads).toBe(0);
    expect(tally.images).toBe(1);
});

test("read, an image becomes its masked text, and the same image is read once", async () => {
    const reader = readers(`PESEL ${PESEL}`);
    const { shield } = shieldWith("read", reader);
    const first = await shield.image({ mediaType: "image/png", data: PNG });
    const second = await shield.image({ mediaType: "image/png", data: PNG });
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toContain("⟦NATIONAL_ID_1⟧");
    expect(JSON.stringify(first)).not.toContain(PESEL);
    expect(reader.reads).toBe(1);
});

test("read, with no reader or nothing read, an image is withheld rather than sent", async () => {
    const { shield } = shieldWith("read", readers(undefined));
    expect(JSON.stringify(await shield.image({ mediaType: "image/png", data: PNG }))).toContain("withheld");
    // An image referred to by address cannot be read here at all.
    const { shield: reading } = shieldWith("read", readers("anything"));
    expect(JSON.stringify(await reading.image({ mediaType: "url", data: "https://example.com/scan.png" }))).toContain("withheld");
});

test("allowed, an image goes as it is and counts for nothing", async () => {
    const { shield, tally } = shieldWith("allow", readers(undefined));
    expect(await shield.image({ mediaType: "image/png", data: PNG })).toBe("keep");
    expect(tally.images).toBe(0);
});

test("a PDF goes as its masked text; one that yields none, or is not a PDF, is withheld", async () => {
    const { shield, tally } = shieldWith("withhold", readers(`Umowa z PESEL ${PESEL}`));
    const out = await shield.document({ mediaType: "application/pdf", data: PDF });
    expect(JSON.stringify(out)).toContain("⟦NATIONAL_ID_1⟧");
    expect(tally.documents).toBe(1);
    const { shield: blank } = shieldWith("withhold", readers(undefined));
    expect(JSON.stringify(await blank.document({ mediaType: "application/pdf", data: PDF }))).toContain("withheld");
    expect(JSON.stringify(await blank.document({ mediaType: "application/msword", data: PDF }))).toContain("withheld");
});

test("watching counts what masking would have replaced and changes nothing", async () => {
    const { privacyShield } = privacySliceFake();
    const masker = createMasker({
        vault: privacyShield.vault,
        policy: { classes: ["national-id"], allow: [], names: "dictionary" },
        memo: createMaskMemo(),
    });
    const tally = emptyTally();
    const shield = watchingShield({ masker, tally, images: "withhold" });
    expect(await shield.mask(`PESEL ${PESEL}`)).toBe(`PESEL ${PESEL}`);
    expect(await shield.image({ mediaType: "image/png", data: PNG })).toBe("keep");
    expect(shield.note).toBeUndefined();
    expect(tally).toEqual({ counts: { "national-id": 1 }, images: 1, documents: 0 });
});
