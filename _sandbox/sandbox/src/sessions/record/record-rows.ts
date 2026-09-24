import type { TranscriptRow } from "@intentic/sandbox-contract";

// How a row is kept. What is long moves out of line (record-blobs.ts) and the row keeps a pointer: a tool output at
// least this long keeps its start, and a delegation's calls at least this long in all keep their count. A page needs
// neither, so it reads a row that is a few kilobytes however much the turn did; the largest record here held 51 of its
// 62 MB in delegations' calls.
const OUT_OF_LINE_CHARS = 16_384;

// What a page carries of one tool output: the pane truncates text at 4000 characters of its own accord
// (toolPresentation.ts TEXT_CAP), so twice that leaves room to raise that cap without a second round trip. Also the
// start an out-of-line output keeps, so a page never needs the blob.
export const PAGE_TEXT_CAP = 8_000;

// A kept output out of line: its start, the blob holding all of it, and how long it is.
interface KeptText {
    type: "text";
    text: string;
    blob?: string;
    chars?: number;
}

// A kept tool: its calls either inline or out of line as a blob of their JSON, with how many there are.
interface KeptTool {
    content?: unknown[];
    children?: KeptTool[];
    calls?: { blob: string; count: number };
    nested?: number;
}

type Get = (hash: string) => Promise<string | undefined>;

const isText = (entry: unknown): entry is KeptText =>
    typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "text" && typeof (entry as { text?: unknown }).text === "string";

// Every tool of a row whose calls are inline, children included, depth first.
const toolsOf = (row: { tools?: KeptTool[] }): KeptTool[] => {
    const all: KeptTool[] = [];
    const visit = (tools: readonly KeptTool[] | undefined): void => {
        for (const tool of tools ?? []) {
            all.push(tool);
            visit(tool.children);
        }
    };
    visit(row.tools);
    return all;
};

// The row as stored: every delegation's long run of calls, then every long output left in view, moved out of line
// through `put`, which answers the blob's name.
export const keptLine = async (row: TranscriptRow, put: (text: string) => Promise<string>): Promise<string> => {
    const kept = structuredClone(row) as { tools?: KeptTool[] };
    for (const tool of kept.tools ?? []) {
        const calls = tool.children === undefined ? "" : JSON.stringify(tool.children);
        if (tool.children !== undefined && calls.length >= OUT_OF_LINE_CHARS) {
            tool.calls = { blob: await put(calls), count: tool.children.length };
            delete tool.children;
        }
    }
    for (const tool of toolsOf(kept)) {
        for (const [at, entry] of (tool.content ?? []).entries()) {
            if (isText(entry) && entry.text.length >= OUT_OF_LINE_CHARS) {
                const text: KeptText = { type: "text", text: entry.text.slice(0, PAGE_TEXT_CAP), blob: await put(entry.text), chars: entry.text.length };
                (tool.content as unknown[])[at] = text;
            }
        }
    }
    return JSON.stringify(kept);
};

// Every blob name in a stored line, read without parsing it: JSON.stringify escapes each quote inside a string, so
// `"blob":"` in a stored line is always a key, and a tool's own input with that key only keeps a blob longer.
const BLOB_NAME = /"blob":"([0-9a-f]{64})"/gu;
export const blobNamesIn = (line: string): string[] =>
    line.includes(`"blob":"`) ? [...line.matchAll(BLOB_NAME)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])) : [];

// Each out-of-line output as the start it kept.
const textsInView = (row: { tools?: KeptTool[] }): void => {
    for (const tool of toolsOf(row)) {
        for (const entry of tool.content ?? []) {
            if (isText(entry)) {
                delete entry.blob;
                delete entry.chars;
            }
        }
    }
};

// Each delegation's calls back in place, or none when their blob is gone (a purge swept it).
const callsBack = async (row: { tools?: KeptTool[] }, get: Get): Promise<void> => {
    for (const tool of row.tools ?? []) {
        if (tool.calls !== undefined) {
            const json = await get(tool.calls.blob);
            if (json !== undefined) {
                tool.children = JSON.parse(json) as KeptTool[];
            }
            delete tool.calls;
        }
    }
};

// A stored line as a page reads it: each out-of-line output as the start it kept, and each delegation as the count of
// its calls, which is what a page carries of them anyway.
export const previewOf = (stored: unknown): unknown => {
    const row = stored as { tools?: KeptTool[] };
    for (const tool of row.tools ?? []) {
        if (tool.calls !== undefined) {
            tool.nested = tool.calls.count;
            delete tool.calls;
        }
    }
    textsInView(row);
    return row;
};

// A stored line with its delegations' calls read back, each output still the start it kept: what opening a delegation's
// card reads, which caps every output at a page's cap anyway.
export const callsOf = async (stored: unknown, get: Get): Promise<unknown> => {
    const row = stored as { tools?: KeptTool[] };
    await callsBack(row, get);
    textsInView(row);
    return row;
};

// A stored line whole again: every delegation's calls and every output read back, an output left as its start when its
// blob is gone, which is still the most the record can say.
export const wholeOf = async (stored: unknown, get: Get): Promise<unknown> => {
    const row = stored as { tools?: KeptTool[] };
    await callsBack(row, get);
    for (const tool of toolsOf(row)) {
        for (const entry of tool.content ?? []) {
            if (isText(entry) && entry.blob !== undefined) {
                entry.text = (await get(entry.blob)) ?? entry.text;
                delete entry.blob;
                delete entry.chars;
            }
        }
    }
    return row;
};
