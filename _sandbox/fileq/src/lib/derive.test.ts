import { SHADOWED_DOCUMENT_EXTENSIONS, STATE_DIR } from "@intentic/constants";
import { documentExtensions } from "./formats.js";
import { ocrPageCap } from "./derivers/pdf.js";
import { ocrCapOf } from "./sidecar.js";
import { isDeriveIgnored } from "./derive.js";

describe("the derive floor (what never gets a shadow, whoever asks)", () => {
    test("machine subtrees, state, the reference shelf and agent worktrees are refused", () => {
        for (const path of [
            "node_modules/pkg/manual.pdf",
            `${STATE_DIR}/local/cache/derived/x.docx`,
            "refs/other-repo/spec.docx",
            ".claude/worktrees/fix/docs/a.pdf",
        ]) {
            expect(isDeriveIgnored(path), path).toBe(true);
        }
    });

    test("ordinary workspace documents are not", () => {
        for (const path of ["docs/spec.docx", "repo/assets/logo.png", "a repo/refs/inner.pdf"]) {
            expect(isDeriveIgnored(path), path).toBe(false);
        }
    });
});

describe("the OCR page cap (interactive 20, the background keeper more)", () => {
    afterEach(() => {
        delete process.env["FILEQ_OCR_PAGES"];
    });

    test("FILEQ_OCR_PAGES raises it; nonsense leaves the default", () => {
        expect(ocrPageCap()).toBe(20);
        process.env["FILEQ_OCR_PAGES"] = "500";
        expect(ocrPageCap()).toBe(500);
        process.env["FILEQ_OCR_PAGES"] = "lots";
        expect(ocrPageCap()).toBe(20);
    });

    test("a rendering's cap is read back off its note; an uncapped one has none", () => {
        expect(ocrCapOf(["scanned: text recognised by OCR", "OCR stops at 20 pages: draw the rest with pdftoppm"])).toBe(20);
        expect(ocrCapOf(["scanned: text recognised by OCR"])).toBeUndefined();
    });
});

test("fileq's document formats are the extensions iq and the preprocessor treat as documents", () => {
    expect(documentExtensions()).toEqual([...SHADOWED_DOCUMENT_EXTENSIONS].toSorted());
});
