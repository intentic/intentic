import type { TranscriptRow } from "@intentic/sandbox-contract";

// What the scratch pad says the conversation is at, above the composer it opens (ChatQuickBar): the last thing said in
// it, by the agent or by the reader, as one plain line the header clamps. Not a transcript: enough to know which chat
// this is and where it stands before writing into it. Notices, tool rows and asks without words are skipped, so the
// line is always words someone said.

export interface LastWords {
    readonly who: `agent` | `you`;
    readonly text: string;
}

// Long enough to fill the header's lines at any width; the rest is the clamp's to cut, and it never reaches a reader.
const MAX = 320;

// Markdown read as plain words: fences, headings, quotes, list markers, emphasis, inline code and links reduced to
// their text, and every run of whitespace to one space, since the header is one paragraph.
export const plainWords = (markdown: string): string =>
    markdown
        .replace(/```[\s\S]*?(```|$)/gu, ` `)
        .replace(/!\[([^\]]*)\]\([^)]*\)/gu, `$1`)
        .replace(/\[([^\]]+)\]\([^)]*\)/gu, `$1`)
        .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gmu, ``)
        .replace(/(\*\*|__|\*|_|~~|`)/gu, ``)
        .replace(/\s+/gu, ` `)
        .trim()
        .slice(0, MAX);

const wordsOf = (row: TranscriptRow): string => {
    if (row.role === `assistant`) {
        return plainWords(row.plan?.text ?? row.text);
    }
    return row.role === `user` ? plainWords(row.text) : ``;
};

export const lastWords = (rows: readonly TranscriptRow[]): LastWords | undefined => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]!;
        const text = wordsOf(row);
        if (text !== ``) {
            return { who: row.role === `user` ? `you` : `agent`, text };
        }
    }
    return undefined;
};
