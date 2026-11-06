import { PERSONAL_DATA_CLASSES } from "@intentic/sandbox-contract/schemas/privacy";
import { type OcrLine, pageText } from "@intentic/ocr/paddle-ocr";
import { grouped, iban, luhn } from "@intentic/privacy-detect/testing";
import { distinctFinds, type MaskRegion, readingText, regionsFor } from "../image-mask.js";
import { createMaskMemo, createMasker } from "../masker.js";
import { privacySliceFake } from "../privacy-slice.testing.js";

// What the shield finds on a picture whose values wrap, laid out as the reader reports a screenshot of a form: labels
// in one column, values in the next, a value too long for its cell going on below it, read row by row. In the rows the
// label beside the second line comes between a value's pieces; the shield reads each wrapped cell again joined.

const WIDTH = 800;
const HEIGHT = 20;

// One line of read text with its top-left at (x, y), each character an equal share of its width.
const lineAt = (text: string, x: number, y: number): OcrLine => {
    const chars = [...text];
    const right = x + chars.length * 10;
    return {
        text,
        score: 0.99,
        corners: [
            { x, y },
            { x: right, y },
            { x: right, y: y + HEIGHT },
            { x, y: y + HEIGHT },
        ],
        chars: chars.map((char, index) => ({ char, from: index / chars.length, to: (index + 1) / chars.length })),
        column: 1 / chars.length,
        vertical: false,
    };
};

// A masker with a vault of its own, which has learned nothing yet.
const freshMasker = () =>
    createMasker({
        vault: privacySliceFake().privacyShield.vault,
        policy: { classes: [...PERSONAL_DATA_CLASSES], allow: [], names: "dictionary" },
        memo: createMaskMemo(),
    });

// What the gateway does with a picture's lines: the finds that count, and where their tokens are painted; and what the
// rows alone would have shown, to a vault that never met the values.
const check = async (lines: readonly OcrLine[]) => {
    const found = await freshMasker().find(readingText(lines), (spans) => distinctFinds(lines, spans));
    return { ...found, regions: regionsFor(lines, found.spans, { width: WIDTH }), rowsAlone: (await freshMasker().find(pageText(lines))).spans };
};

// The tokens painted on a line (at its height, over some of its width), and how much of it they cover, from its start
// to its end as fractions.
const paintedOn = (regions: readonly MaskRegion[], line: OcrLine) => {
    const [topLeft, topRight] = line.corners;
    const on = regions.filter((region) => {
        const middle = region.corners.reduce((sum, point) => sum + point.y, 0) / 4;
        const xs = region.corners.map((point) => point.x);
        return middle > topLeft.y && middle < topLeft.y + HEIGHT && Math.min(...xs) < topRight.x && Math.max(...xs) > topLeft.x;
    });
    const xs = on.flatMap((region) => region.corners.map((point) => point.x));
    const width = topRight.x - topLeft.x;
    return {
        tokens: on.map((region) => region.token),
        from: xs.length === 0 ? undefined : (Math.min(...xs) - topLeft.x) / width,
        to: xs.length === 0 ? undefined : (Math.max(...xs) - topLeft.x) / width,
    };
};

test("an IBAN its table cell wraps is found whole, painted on both its lines and counted once", async () => {
    const account = grouped(iban("PL", "109010140000071219812874"));
    const head = lineAt(account.slice(0, 24), 300, 0);
    const tail = lineAt(account.slice(25), 300, 24);
    const label = lineAt("Rachunek bankowy", 0, 0);
    const labelTail = lineAt("(IBAN)", 0, 24);
    const lines = [label, head, labelTail, tail, lineAt("Karta płatnicza", 0, 60)];
    const found = await check(lines);
    // Read row by row, as before, the number is two pieces with "(IBAN)" between them, and neither is an account.
    expect(found.rowsAlone).toEqual([]);
    expect(found.counts).toEqual({ "bank-account": 1 });
    const tokens = found.spans.map((span) => span.token);
    expect(paintedOn(found.regions, head).tokens).toEqual(tokens);
    expect(paintedOn(found.regions, tail).tokens).toEqual(tokens);
    expect(paintedOn(found.regions, label).tokens).toEqual([]);
    expect(paintedOn(found.regions, labelTail).tokens).toEqual([]);
});

test("an account a paragraph wraps is found across the break", async () => {
    const account = grouped(iban("PL", "109010140000071219812874"));
    const lines = [lineAt(`Proszę o przelew na konto ${account.slice(0, 14)}`, 0, 0), lineAt(`${account.slice(15)} do piątku.`, 0, 22)];
    const found = await check(lines);
    expect(found.rowsAlone).toEqual([]);
    expect(found.counts).toEqual({ "bank-account": 1 });
});

test("an address whose postal code and town wrap is covered whole, the street within it counted once with it", async () => {
    const warsaw = [lineAt("ul. Lipowa 12/4, 00-901", 300, 0), lineAt("Warszawa", 300, 24)] as const;
    // Broken inside the postal code, at its hyphen.
    const krakow = [lineAt("ul. Ogrodowa 8/17, 30-", 300, 100), lineAt("059 Kraków", 300, 124)] as const;
    const lines = [lineAt("Adres", 0, 0), warsaw[0], lineAt("korespondencyjny", 0, 24), warsaw[1], lineAt("Adres", 0, 100), krakow[0], krakow[1]];
    const found = await check(lines);
    expect(found.counts).toEqual({ address: 2 });
    for (const [street, town] of [warsaw, krakow]) {
        const painted = paintedOn(found.regions, street);
        expect(painted.from).toBeLessThanOrEqual(0);
        expect(painted.to).toBeGreaterThanOrEqual(1);
        expect(paintedOn(found.regions, town).tokens).toEqual(painted.tokens);
    }
});

test("rows close enough to read as one wrapped cell still have each of their values found", async () => {
    const visa = lineAt(grouped(luhn("411111111111111")), 0, 0);
    const mastercard = lineAt(grouped(luhn("555555555555444")), 0, 22);
    // Read again joined, the two numbers are one run of digits that is neither card.
    expect(readingText([visa, mastercard])).toBe(`${pageText([visa, mastercard])}\n${visa.text} ${mastercard.text}`);
    const found = await check([visa, mastercard]);
    expect(found.counts).toEqual({ "payment-card": 2 });
    expect(paintedOn(found.regions, visa).tokens).toHaveLength(1);
    expect(paintedOn(found.regions, mastercard).tokens).toHaveLength(1);
    expect(paintedOn(found.regions, visa).tokens).not.toEqual(paintedOn(found.regions, mastercard).tokens);
});

test("a picture with nothing wrapped reads exactly as its rows", () => {
    const lines = [lineAt("PESEL", 0, 0), lineAt("44051401458", 300, 0), lineAt("NIP", 0, 60), lineAt("526-100-00-07", 300, 60)];
    expect(readingText(lines)).toBe(pageText(lines));
});
