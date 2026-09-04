import { readFile } from "node:fs/promises";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* Jupyter notebooks: JSON whose cells ARE the document. Markdown cells pass through as they are, code cells
 * become fences in the kernel's language, and each cell's outputs follow it — the text ones, capped, because
 * a training loop that printed forty thousand lines is not what a reader of the notebook came for. Rich
 * outputs (images, HTML widgets) are counted and named, never inlined: a base64 PNG in a sidecar is a
 * megabyte that says nothing to a text reader, and a model with vision opens the notebook's own files. */

const MAX_OUTPUT_LINES = 40;

interface Output {
    readonly output_type?: string;
    readonly text?: string | string[];
    readonly data?: Record<string, string | string[]>;
    readonly ename?: string;
    readonly evalue?: string;
}

interface Cell {
    readonly cell_type?: string;
    readonly source?: string | string[];
    readonly outputs?: Output[];
}

interface Notebook {
    readonly cells?: Cell[];
    readonly metadata?: { readonly language_info?: { readonly name?: string }; readonly kernelspec?: { readonly language?: string } };
}

interface Counters {
    rich: number;
    clipped: number;
}

// nbformat stores multi-line text as an array of lines (newlines included) or, from older writers, one string.
const joined = (value: string | string[] | undefined): string => (Array.isArray(value) ? value.join("") : (value ?? ""));

const linesOf = (value: string | string[] | undefined): string[] => joined(value).trimEnd().split("\n");

const outputLines = (output: Output, counters: Counters): string[] => {
    if (output.output_type === "stream") {
        return linesOf(output.text);
    }
    if (output.output_type === "error") {
        return [`${output.ename ?? "Error"}: ${output.evalue ?? ""}`.trimEnd()];
    }
    if (output.data === undefined) {
        return [];
    }
    const plain = output.data["text/plain"];
    if (plain !== undefined) {
        return linesOf(plain);
    }
    counters.rich += 1;
    return [`[${Object.keys(output.data).join(", ")} output omitted]`];
};

const codeCell = (cell: Cell, source: string, language: string, counters: Counters): string => {
    const block = [`\`\`\`${language}`, source, "```"];
    const lines = (cell.outputs ?? []).flatMap((output) => outputLines(output, counters));
    if (lines.length === 0) {
        return block.join("\n");
    }
    const kept = lines.slice(0, MAX_OUTPUT_LINES);
    if (lines.length > MAX_OUTPUT_LINES) {
        counters.clipped += 1;
        kept.push(`… ${lines.length - MAX_OUTPUT_LINES} more output lines`);
    }
    return [...block, "", "```text", ...kept, "```"].join("\n");
};

// One cell as a markdown section, or undefined for a cell with nothing to show.
const sectionOf = (cell: Cell, language: string, counters: Counters): string | undefined => {
    const source = joined(cell.source).trimEnd();
    if (cell.cell_type === "code") {
        return codeCell(cell, source, language, counters);
    }
    if (source === "") {
        return undefined;
    }
    // Markdown cells are already markdown; raw cells are fenced so their text cannot pose as prose.
    return cell.cell_type === "markdown" ? source : ["```text", source, "```"].join("\n");
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

const notesOf = (cellCount: number, counters: Counters): string[] => {
    const notes: string[] = [];
    if (cellCount === 0) {
        notes.push("no cells in this notebook");
    }
    if (counters.clipped > 0) {
        notes.push(`${plural(counters.clipped, "cell")}: output cut at ${MAX_OUTPUT_LINES} lines`);
    }
    if (counters.rich > 0) {
        notes.push(`${plural(counters.rich, "rich output")} (images, HTML) omitted: a notebook's pictures need the notebook itself`);
    }
    return notes;
};

export const ipynbDeriver: Deriver = {
    name: "ipynb",
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const notebook = JSON.parse(await readFile(absPath, "utf8")) as Notebook;
        const language = notebook.metadata?.language_info?.name ?? notebook.metadata?.kernelspec?.language ?? "python";
        const cells = Array.isArray(notebook.cells) ? notebook.cells : [];
        const counters: Counters = { rich: 0, clipped: 0 };
        const sections = cells.map((cell) => sectionOf(cell, language, counters)).filter((section): section is string => section !== undefined);
        // The first markdown heading is the notebook's own idea of its title.
        const title = cells
            .filter((cell) => cell.cell_type === "markdown")
            .map((cell) => /^#\s+(.+)$/m.exec(joined(cell.source))?.[1]?.trim())
            .find((heading) => heading !== undefined);
        return { markdown: sections.join("\n\n"), title, notes: notesOf(cells.length, counters) };
    },
};
