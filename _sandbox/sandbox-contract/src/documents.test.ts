import { describe, expect, test } from "vitest";
import { documentOf, documentTitle, isDocumentPath, isPlanDocumentPath } from "./documents.js";
import { PLAN_DOCUMENTS_DIR } from "./workspace-state.js";

const write = (path: string, newText: string, extra: { oldText?: string; truncated?: boolean } = {}) => [
    { type: "diff" as const, path, newText, ...extra },
];

describe("documentOf", () => {
    test("a markdown file written whole is a document, titled by its opening heading", () => {
        expect(documentOf("Write", write("docs/findings.md", "# Why it is slow\n\nBecause of the poll."))).toEqual({
            path: "docs/findings.md",
            title: "Why it is slow",
            markdown: "# Why it is slow\n\nBecause of the poll.",
        });
    });

    test("a plan file says so, which is what gives it the plan card's face", () => {
        const document = documentOf("Write", write(`${PLAN_DOCUMENTS_DIR}/wiggly-spring.md`, "## The plan\n\nStep one."));
        expect(document?.plan).toBe(true);
        expect(document?.title).toBe("The plan");
    });

    test("carries the wire cap forward, so a clipped document can say it is clipped", () => {
        expect(documentOf("Write", write("notes.md", "# Notes", { truncated: true }))?.truncated).toBe(true);
    });

    test("an EDIT to a document is not one: its newText is a fragment, and the change is what a reader wants", () => {
        expect(documentOf("Edit", write("docs/findings.md", "a replaced paragraph", { oldText: "the old paragraph" }))).toBeUndefined();
    });

    test("code is not a document, whatever it was written with", () => {
        expect(documentOf("Write", write("src/foo.ts", "export const x = 1;"))).toBeUndefined();
    });

    test("a call with no diff has written nothing to show", () => {
        expect(documentOf("Write", [{ type: "text", text: "File created successfully." }])).toBeUndefined();
        expect(documentOf("Write", undefined)).toBeUndefined();
    });

    test("names arrive in whatever case a backend spells them", () => {
        expect(documentOf("write", write("notes.md", "# Notes"))?.path).toBe("notes.md");
    });
});

describe("documentTitle", () => {
    test("falls back to the file name when the document opens with prose", () => {
        expect(documentTitle("No heading here, just prose.", "docs/some-notes.md")).toBe("some-notes.md");
    });

    test("takes the heading whatever its depth", () => {
        expect(documentTitle("###### deep\n", "notes.md")).toBe("deep");
    });
});

describe("paths", () => {
    test("markdown, by either extension, in any case", () => {
        expect(isDocumentPath("a/b.md")).toBe(true);
        expect(isDocumentPath("a/b.MARKDOWN")).toBe(true);
        expect(isDocumentPath("a/b.txt")).toBe(false);
    });

    test("a plan is one by where it lives, not by what it is called", () => {
        expect(isPlanDocumentPath(`${PLAN_DOCUMENTS_DIR}/anything.md`)).toBe(true);
        expect(isPlanDocumentPath("docs/plans/anything.md")).toBe(false);
    });
});
