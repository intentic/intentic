import { describe, expect, test } from "vitest";
import { isCandidatePath } from "./formats.js";
import { isDeriveIgnored } from "./derive.js";

describe("the candidate pre-filter (what the daemon runs over every watcher batch)", () => {
    test("derivable extensions pass, case-blind", () => {
        for (const path of [
            "docs/spec.docx",
            "a/b/Report.PDF",
            "photo.JPEG",
            "call.mp3",
            "deck.pptx",
            "page.html",
            "analysis.ipynb",
            "letter.odt",
            "book.EPUB",
        ]) {
            expect(isCandidatePath(path), path).toBe(true);
        }
    });

    test("code and plain text never cost a spawn", () => {
        for (const path of ["src/index.ts", "README.md", "data.csv", "notes.txt", "archive.zip", "legacy.doc"]) {
            expect(isCandidatePath(path), path).toBe(false);
        }
    });
});

describe("the derive floor (what never gets a shadow, whoever asks)", () => {
    test("machine subtrees, state, the reference shelf and agent worktrees are refused", () => {
        for (const path of [
            "node_modules/pkg/manual.pdf",
            ".intentic/local/cache/derived/x.docx",
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
