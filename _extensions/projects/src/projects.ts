// The dashboard's pure halves: which repositories are projects, what a tile says, and the name a new project gets.

import type { FigureAccent } from "@intentic/extension-ui";

// A tile: one repository under the workspace root. "root" is the workspace itself and is never a tile, since the
// dashboard is the list of things inside it.
export interface ProjectTile {
    // The repository id the daemon's routes take, which is also its folder under the workspace root.
    readonly id: string;
    readonly name: string;
    // Two letters in place of a glyph: every tile would otherwise wear the same folder.
    readonly monogram: string;
    // Which categorical palette slot the monogram plate wears; fixed by the id, so a project keeps its colour.
    readonly accent: FigureAccent;
    // The README's first paragraph as one clamped line of plain text, or empty while it has none.
    readonly summary: string;
    // Whether the Preview area can show it running (a dev server the daemon knows how to start).
    readonly hasPanel: boolean;
}

export const projectIds = (repos: readonly string[]): string[] => repos.filter((id) => id !== `root`).toSorted((left, right) => left.localeCompare(right));

// As many characters as two clamped lines hold at a tile's width; past it the paragraph is cut here rather than
// left for the clamp to hide.
const SUMMARY_LIMIT = 120;
// Under this a cut at the first full stop reads as a fragment ("A tool, e.g."), so the word cut is used instead.
const SENTENCE_FLOOR = 40;

// One level of nesting inside a target, since a shields.io badge URL carries parentheses of its own.
const TARGET = String.raw`\((?:[^()]|\([^()]*\))*\)`;
// Named, not `<[^>]*>`: a README writes placeholders in angle brackets (`*.<zone>`) that are not markup.
const HTML_TAGS = [
    `a|abbr|b|blockquote|br|center|code|dd|details|div|dl|dt|em|figcaption|figure|font|h[1-6]|hr|i|iframe|img`,
    `kbd|li|ol|p|picture|pre|q|s|samp|section|small|source|span|strong|sub|summary|sup|svg|table|tbody|td|th`,
    `thead|tr|u|ul|var|video`,
].join(`|`);

// Applied in order: images before links, tags before entities, or each rule eats the next one's input.
const PLAIN_TEXT: readonly (readonly [RegExp, string])[] = [
    [/<!--[\s\S]*?-->/g, ` `],
    [new RegExp(String.raw`</?(?:${HTML_TAGS})(?:\s[^>]*)?/?>`, `gi`), ` `],
    [new RegExp(String.raw`!\[[^\]]*\]${TARGET}`, `g`), ` `],
    [new RegExp(String.raw`\[([^\]]*)\]${TARGET}`, `g`), `$1`],
    [/\[([^\]]*)\]\[[^\]]*\]/g, `$1`],
    [/`([^`]*)`/g, `$1`],
    // Lazy, because a bold span routinely has an italic one inside it.
    [/\*\*([\s\S]*?)\*\*/g, `$1`],
    [/__([\s\S]*?)__/g, `$1`],
    [/\*([^*]+)\*/g, `$1`],
    [/^\s*[>#]+\s*/gm, ``],
];

const ENTITIES: Readonly<Record<string, string>> = {
    amp: `&`,
    apos: `'`,
    gt: `>`,
    hellip: `…`,
    lt: `<`,
    mdash: `—`,
    ndash: `–`,
    nbsp: ` `,
    quot: `"`,
};

const MAX_CODE_POINT = 0x10ffff;

// An entity this table doesn't know stays as it was written, which reads better than a replacement character.
const decoded = (text: string): string =>
    text.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (whole: string, code: string): string => {
        if (!code.startsWith(`#`)) {
            return ENTITIES[code.toLowerCase()] ?? whole;
        }
        const point = /^#x/i.test(code) ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
        return Number.isInteger(point) && point >= 0 && point <= MAX_CODE_POINT ? String.fromCodePoint(point) : whole;
    });

const asPlainLine = (block: string): string => {
    let text = block;
    for (const [pattern, replacement] of PLAIN_TEXT) {
        text = text.replace(pattern, replacement);
    }
    return decoded(text).replace(/\s+/g, ` `).trim();
};

// A heading, a rule, a fence, a list, a table row: shapes a summary line cannot carry, whatever they clean up to.
// A heading is one written as `<h1>` too, which the tag strip would otherwise hand over as a sentence.
const isProse = (block: string): boolean => !/^(?:#|-{3,}|={3,}|\*{3,}|```|~~~|[-*+]\s|\d+[.)]\s|\||<h[1-6][\s>/])/i.test(block);

// Whole sentences while they fit, then a whole word; never a cut mid-word.
const clamped = (line: string): string => {
    if (line.length <= SUMMARY_LIMIT) {
        return line;
    }
    let kept = ``;
    // Split on a full stop followed by a space, so `api.openai.com` and `*.zone` stay whole.
    for (const sentence of line.split(/(?<=[.!?]["')\]]*)\s+/)) {
        const grown = kept === `` ? sentence : `${kept} ${sentence}`;
        if (grown.length > SUMMARY_LIMIT) {
            break;
        }
        kept = grown;
    }
    if (kept.length >= SENTENCE_FLOOR && /[.!?]["')\]]*$/.test(kept)) {
        return kept;
    }
    const cut = line.slice(0, SUMMARY_LIMIT);
    const lastSpace = cut.lastIndexOf(` `);
    return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:—–-]+$/, ``)}…`;
};

// The first paragraph of a README as one plain line: the file's own markup and HTML are the author's, not the tile's.
export const summaryOf = (readme: string): string => {
    const blocks = readme
        .replace(/\r\n/g, `\n`)
        .replace(/^(```|~~~)[\s\S]*?^\1/gm, ` `)
        .split(/\n\s*\n/);
    for (const block of blocks) {
        const raw = block.trim();
        if (raw === `` || !isProse(raw)) {
            continue;
        }
        const line = asPlainLine(raw);
        if (line !== ``) {
            return clamped(line);
        }
    }
    return ``;
};

// The name a press on New project gives before anyone types: the first free one in the series, so two presses in a
// row make two projects rather than one refusal.
export const freeProjectName = (existing: readonly string[], base = `new-project`): string => {
    const taken = new Set(existing);
    if (!taken.has(base)) {
        return base;
    }
    for (let n = 2; ; n++) {
        if (!taken.has(`${base}-${n}`)) {
            return `${base}-${n}`;
        }
    }
};

// What a typed name becomes as a folder: lowercase, words joined with hyphens, nothing git or a path would choke on.
// The daemon has the last word (isValidRepoName); this only keeps the common case from being refused.
export const slugOf = (typed: string): string =>
    typed
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, `-`)
        .replace(/^[^a-z0-9]+/, ``)
        .replace(/-+$/, ``);

// What the rail tile wears while a project is open: the first two letters of its name (the last path segment, so
// `tools/cli` reads CL), upper-cased by the rail. Two letters, not initials: a name is read from its start.
export const monogramOf = (project: string): string => (project.split(`/`).pop() ?? project).slice(0, 2);

const ACCENT_SLOTS = [`1`, `2`, `3`, `4`, `5`] as const satisfies readonly FigureAccent[];

// A hash, not a position: a tile's colour must not change when a project sorted above it is added or removed.
export const accentOf = (id: string): FigureAccent => {
    let total = 7;
    for (const character of id) {
        total = (total * 31 + (character.codePointAt(0) ?? 0)) % 1_000_003;
    }
    return ACCENT_SLOTS[total % ACCENT_SLOTS.length] ?? `1`;
};

// Where a tile opens once the project is the shell's scope: the workspace, which roots itself at the open project.
export const WORKSPACE_PATH = `/workspace`;

// Where See it opens: the Preview area on this repository's own target (previewModel.repoTargetId).
export const previewPath = (id: string): string => `/preview?target=${encodeURIComponent(`repo:${id}`)}`;
