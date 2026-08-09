/* A GOOGLE DOC AS TEXT. The Docs API describes a document as a tree of structural elements whose leaves are
 * runs of styled text, and every consumer here wants the prose back out of it.
 *
 * Headings, lists and tables are marked in the flattened text rather than dropped, because a model asked to
 * summarize or edit a document needs to know which line was a heading — and `#` is both the cheapest marker
 * and the one it already reads everywhere else. */

interface TextRun {
    readonly content?: string;
}
interface ParagraphElement {
    readonly textRun?: TextRun;
}
interface Paragraph {
    readonly elements?: readonly ParagraphElement[];
    readonly paragraphStyle?: { readonly namedStyleType?: string };
    readonly bullet?: unknown;
}
interface StructuralElement {
    readonly paragraph?: Paragraph;
    readonly table?: { readonly tableRows?: readonly { readonly tableCells?: readonly { readonly content?: readonly StructuralElement[] }[] }[] };
    readonly tableOfContents?: { readonly content?: readonly StructuralElement[] };
}

export interface GoogleDoc {
    readonly title?: string;
    readonly body?: { readonly content?: readonly StructuralElement[] };
}

const HEADINGS: Record<string, string> = {
    HEADING_1: "# ",
    HEADING_2: "## ",
    HEADING_3: "### ",
    HEADING_4: "#### ",
    HEADING_5: "##### ",
    HEADING_6: "###### ",
    TITLE: "# ",
    SUBTITLE: "## ",
};

const paragraphText = (paragraph: Paragraph): string => {
    const text = (paragraph.elements ?? [])
        .map((element) => element.textRun?.content ?? "")
        .join("")
        // The Docs API encodes a soft line break inside a paragraph as a vertical tab.
        .replaceAll("\v", "\n")
        .trimEnd();
    if (text === "") {
        return "";
    }
    const prefix = HEADINGS[paragraph.paragraphStyle?.namedStyleType ?? ""] ?? (paragraph.bullet === undefined ? "" : "- ");
    return `${prefix}${text}`;
};

const flatten = (content: readonly StructuralElement[] | undefined): string[] => {
    const lines: string[] = [];
    for (const element of content ?? []) {
        if (element.paragraph !== undefined) {
            lines.push(paragraphText(element.paragraph));
            continue;
        }
        if (element.table !== undefined) {
            for (const tableRow of element.table.tableRows ?? []) {
                // One table row per line, cells separated — enough to read a table, not a rendering of one.
                lines.push((tableRow.tableCells ?? []).map((cell) => flatten(cell.content).join(" ").trim()).join(" | "));
            }
            continue;
        }
        lines.push(...flatten(element.tableOfContents?.content));
    }
    return lines;
};

export const documentText = (doc: GoogleDoc): string => flatten(doc.body?.content).join("\n").replaceAll(/\n{3,}/g, "\n\n").trim();
