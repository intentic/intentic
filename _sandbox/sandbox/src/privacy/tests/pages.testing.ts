import { execFileSync } from "node:child_process";

// Pages for the readers' suites to read: a PDF drawn by hand, and whether the binary that draws or reads it is here.

// A one-page PDF with a text layer, written out by hand so the suite needs no PDF writer.
export const pdfWith = (text: string): Buffer => {
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

export const installed = (binary: string): boolean => {
    try {
        execFileSync("sh", ["-c", `command -v ${binary}`], { stdio: "ignore" });
        return true;
    } catch {
        // allow(silent-catch): `command -v` failing is the answer: the binary is not on PATH.
        return false;
    }
};
