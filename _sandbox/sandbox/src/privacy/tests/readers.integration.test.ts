import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { createLocalReaders } from "../readers.js";

// The local readers over the real binaries: poppler's pdftotext ships in the image, tesseract only with the privacy
// pack, so each case runs where its binary is and says why where it is not.

// A one-page PDF with a text layer, written out by hand so the suite needs no PDF writer.
const pdfWith = (text: string): Buffer => {
    const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((object, index) => {
        offsets.push(out.length);
        out += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
};

const installed = (binary: string): boolean => {
    try {
        execFileSync("sh", ["-c", `command -v ${binary}`], { stdio: "ignore" });
        return true;
    } catch {
        // allow(silent-catch): `command -v` failing is the answer: the binary is not on PATH.
        return false;
    }
};

const poppler = requires(installed("pdftotext") && installed("pdftoppm"), "poppler (pdftotext, pdftoppm) on PATH");
const tesseract = requires(installed("tesseract"), "tesseract on PATH");

test.skipIf(!poppler.runs)(poppler.title("a PDF's text layer is read on this machine"), async () => {
    const text = await createLocalReaders().readPdf(pdfWith("Klient: Jan Kowalski, PESEL 44051401458"));
    expect(text).toContain("Jan Kowalski, PESEL 44051401458");
});

test.skipIf(!poppler.runs)(poppler.title("bytes that are no PDF read as nothing, never as an error"), async () => {
    expect(await createLocalReaders().readPdf(Buffer.from("not a pdf"))).toBeUndefined();
});

// The page drawn to an image is what a screenshot of a document is; reading it back is what `images: "read"` does.
test.skipIf(!poppler.runs || !tesseract.runs)(tesseract.title("an image's text is read on this machine"), async () => {
    const dir = await mkdtemp(join(tmpdir(), "privacy-ocr-"));
    try {
        await writeFile(join(dir, "page.pdf"), pdfWith("Klient Jan Kowalski"));
        execFileSync("pdftoppm", ["-r", "200", "-png", "-singlefile", join(dir, "page.pdf"), join(dir, "page")]);
        const readers = createLocalReaders();
        expect(await readers.ocr()).toBe(true);
        expect(await readers.readImage(await readFile(join(dir, "page.png")))).toContain("Kowalski");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
