import type { TranscriptRow } from "../events/transcript.js";
import { deliverableKindOf, documentOf, documentTitle, isDocumentPath, isPlanDocumentPath, producedDocumentPaths } from "./documents.js";
import { PLAN_DOCUMENTS_DIR } from "../state/workspace-state.js";

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

describe("deliverableKindOf", () => {
    test("names each kind by its extension, in any case, `.htm` a web page too", () => {
        expect(["q3/report.docx", "deck.PPTX", "numbers.xlsx", "scan.pdf", "site/index.html", "old/page.HTM"].map(deliverableKindOf)).toEqual([
            "docx",
            "pptx",
            "xlsx",
            "pdf",
            "html",
            "html",
        ]);
    });

    test("anything else is none: source, markdown, the old binary formats, a dotfile, a directory's dot", () => {
        expect(["src/app.ts", "notes.md", "letter.doc", ".pdf", "release.v2/README", "docx"].map(deliverableKindOf)).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
        ]);
    });
});


test("ODF text, sheets, slides and RTF are result documents", () => {
    expect(["letter.ODT", "budget.ods", "briefing.odp", "letter.rtf"].map(deliverableKindOf)).toEqual(["odt", "ods", "odp", "rtf"]);
});

describe("producedDocumentPaths", () => {
    const rows: TranscriptRow[] = [
        { role: "user", text: "make me letter.odt and notes.pdf" },
        {
            role: "assistant",
            text: "Done",
            tools: [
                { id: "1", name: "Write", category: "edit", status: "completed", content: write("./out/letter.odt", "") },
                { id: "2", name: "Write", category: "edit", status: "failed", locations: [{ path: "broken.docx" }] },
                { id: "3", name: "Bash", category: "execute", status: "failed", locations: [{ path: "deck.pptx" }, { path: "build.log" }] },
                { id: "4", name: "Bash", category: "execute", status: "completed", locations: [{ path: "draft.pdf" }] },
                { id: "5", name: "Bash", category: "delete", status: "completed", locations: [{ path: "draft.pdf" }] },
                { id: "6", name: "Read", category: "read", status: "completed", locations: [{ path: "source.xlsx" }] },
                { id: "7", name: "Task", category: "think", status: "completed", children: [{ id: "8", name: "Write", category: "edit", status: "completed", locations: [{ path: "budget.ods" }] }] },
            ],
        },
    ];

    test("lists what settled calls recorded writing, never what prose or a read named, minus what was deleted", () => {
        expect(producedDocumentPaths(rows)).toEqual(["out/letter.odt", "deck.pptx", "budget.ods"]);
    });
});
