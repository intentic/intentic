import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSONAL_DATA_CLASSES } from "@intentic/sandbox-contract";
import { requires } from "@intentic/testing/requires";
import { pesel } from "../detect/tests/ids.testing.js";
import { ocrInstalled, ocrModelDir } from "@intentic/ocr/models";
import { loadTextReader } from "@intentic/ocr/paddle-ocr";
import { paintRegions, readingText, regionsFor } from "../image-mask.js";
import { createMaskMemo, createMasker } from "../masker.js";
import { privacySliceFake } from "../privacy-slice.testing.js";
import { createLocalReaders } from "../readers.js";
import { installed, pdfWith } from "./pages.testing.js";

// An image masked the way the gateway masks one, then read again by the same reader: what an untrusted provider's model
// can make of the picture it is sent. The value must be gone, its token legible where it was, and the text around it
// untouched. Against the real PP-OCRv6 models, where they are (the privacy pack, and the CI image).

const ocr = requires(ocrInstalled() && installed("pdftoppm"), `the PP-OCRv6 models at ${ocrModelDir()} and pdftoppm on PATH`);

test.skipIf(!ocr.runs)(ocr.title("a masked image read again holds the token where the value was, and the rest as it was"), async () => {
    const value = pesel(1985, 3, 14);
    const dir = await mkdtemp(join(tmpdir(), "privacy-mask-"));
    // One reader for both reads, released at the end: its model sessions are native memory that the one process every
    // integration file of the package runs in would otherwise hold to the end of the run.
    const reader = await loadTextReader();
    try {
        await writeFile(join(dir, "page.pdf"), pdfWith(`PESEL: ${value} Faktura 12/2026`));
        execFileSync("pdftoppm", ["-r", "200", "-png", "-singlefile", join(dir, "page.pdf"), join(dir, "page")]);
        const image = await readFile(join(dir, "page.png"));
        const readers = createLocalReaders({ textReader: async () => reader });
        const reading = await readers.readImage(image);
        if (reading === undefined) {
            throw new Error("the page did not read");
        }
        expect(readingText(reading.lines)).toContain(value);

        const { privacyShield } = privacySliceFake();
        const masker = createMasker({
            vault: privacyShield.vault,
            policy: { classes: [...PERSONAL_DATA_CLASSES], allow: [], names: "dictionary" },
            memo: createMaskMemo(),
        });
        const found = await masker.find(readingText(reading.lines));
        expect(found.counts).toEqual({ "national-id": 1 });
        const painted = await paintRegions(image, regionsFor(reading.lines, found.spans, reading));
        expect(painted?.mediaType).toBe("image/png");

        const again = await readers.readImage(Buffer.from(painted?.data ?? "", "base64"));
        const text = readingText(again?.lines ?? []);
        // No run of the number survives, not even four of its digits in a row.
        const runs = Array.from({ length: value.length - 3 }, (_, at) => value.slice(at, at + 4));
        expect(runs.filter((run) => text.includes(run))).toEqual([]);
        // The token's lettering reads back as its label, and what was not personal stays as it was drawn. Case aside: the
        // reader takes small capitals for lower case often enough (CI read "INATIonAL_ID_11", the bracket as an I).
        expect(text).toMatch(/NATI[O0]NAL_ID/iu);
        expect(text).toContain("PESEL");
        expect(text).toContain("Faktura 12/2026");
    } finally {
        await reader?.release();
        await rm(dir, { recursive: true, force: true });
    }
});
