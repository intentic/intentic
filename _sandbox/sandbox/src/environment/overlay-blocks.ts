// Reads an overlay fragment the way a person would: name, purpose, and which commands land on PATH, from text alone (no
// filesystem, no probing). Kept in one place and pinned in a test rather than rotting silently beside each fragment.
// Version is never inferred: an install line is a bad source for one, so this only names candidates; version-probe.ts
// asks them.

// Delimits named blocks in the custom section, one per thing asked for, named after its draft file.
const BLOCK_MARKER = /^#\s*----\s*(.+?)\s*----\s*$/;

export interface OverlayBlock {
    // The marker's name for a custom block; for a capability fragment, whatever its contributor is called.
    readonly name: string;
    // The block's lines, comments included.
    readonly body: string;
}

// Splits the custom section into blocks; text before the first marker is a block too (an older, unnamed custom
// section), kept rather than dropped and under-reported.
export const splitBlocks = (content: string): OverlayBlock[] => {
    const blocks: OverlayBlock[] = [];
    let name = "";
    let lines: string[] = [];
    const flush = (): void => {
        const body = lines.join("\n").trim();
        if (body !== "") {
            blocks.push({ name, body });
        }
        lines = [];
    };
    for (const line of content.split("\n")) {
        const marker = BLOCK_MARKER.exec(line);
        if (marker?.[1] !== undefined) {
            flush();
            name = marker[1];
            continue;
        }
        lines.push(line);
    }
    flush();
    return blocks;
};

// A comment line's text, or undefined if it isn't one; a bare `#` is a paragraph break, so empty string must stay
// distinct from "not a comment".
const commentText = (line: string): string | undefined => {
    const trimmed = line.trim();
    return trimmed.startsWith("#") ? trimmed.replace(/^#+\s?/, "").trimEnd() : undefined;
};

// A comment addressed to the rebuild executor, not a reader; it's a comment only because a Dockerfile has nowhere else
// to put it.
const isDirective = (text: string): boolean => text.startsWith("intentic:");

// Strips a fragment's self-naming prefix ("docker capability: …"), since the row is already titled, grouped, and
// attributed the same way. Anchored on the label the daemon actually knows, so an unrelated colon-led sentence is left
// alone.
const withoutSource = (prose: string, source: string | undefined): string => {
    if (source === undefined) {
        return prose;
    }
    const prefix = /^(.{0,40}?):\s+/.exec(prose);
    if (prefix?.[1]?.toLowerCase().startsWith(source.toLowerCase()) !== true) {
        return prose;
    }
    const rest = prose.slice(prefix[0].length);
    return rest.charAt(0).toUpperCase() + rest.slice(1);
};

// A bullet keeps its own line; prose gets unwrapped, since fragments are hard-wrapped at ~120 columns.
const isBullet = (text: string): boolean => /^[•*-]\s/.test(text) || /^\s+/.test(text);

// The block's explanation, unwrapped into paragraphs; only comments above the first instruction count, since ones
// further down annotate a specific command, not the block's purpose. `source` lets an opening line naming it be
// stripped (withoutSource).
export const blockProse = (body: string, source?: string): string => {
    const paragraphs: string[] = [];
    let current: string[] = [];
    const flush = (): void => {
        if (current.length > 0) {
            paragraphs.push(current.join("\n"));
            current = [];
        }
    };
    for (const line of body.split("\n")) {
        const text = commentText(line);
        if (text === undefined) {
            break;
        }
        if (isDirective(text)) {
            continue;
        }
        if (text === "") {
            flush();
            continue;
        }
        const last = current.at(-1);
        if (last === undefined || isBullet(text) || isBullet(last)) {
            current.push(text);
            continue;
        }
        current[current.length - 1] = `${last} ${text}`;
    }
    flush();
    return withoutSource(paragraphs.join("\n\n"), source);
};

// Abbreviations whose full stop doesn't end a sentence; without these, purposeOf cuts at the first "e.g.".
const ABBREVIATIONS = ["e.g", "i.e", "etc", "vs", "cf", "no", "approx"];

// Where the first sentence ends; a full stop only counts when followed by whitespace or end, so a version number or
// file name doesn't split the line.
const firstSentenceEnd = (text: string): number => {
    for (const match of text.matchAll(/\.(?=\s|$)/g)) {
        const at = match.index;
        const before = text.slice(0, at);
        if (/\d$/.test(before) || ABBREVIATIONS.some((word) => before.toLowerCase().endsWith(word))) {
            continue;
        }
        return at + 1;
    }
    return -1;
};

// Row's line is the opening sentence with any trailing parenthetical dropped, kept in the prose behind it.
// Past this length a purpose reads as multiple lines; an over-long sentence keeps only its first clause.
const PURPOSE_LIMIT = 130;

export const purposeOf = (prose: string): string | undefined => {
    const paragraph = prose.split("\n\n")[0]?.replace(/\n/g, " ").trim() ?? "";
    if (paragraph === "") {
        return undefined;
    }
    const end = firstSentenceEnd(paragraph);
    const sentence = end === -1 ? paragraph : paragraph.slice(0, end);
    // Drops a trailing parenthetical unless that leaves too little to read (a bare "Bun." is worse).
    const trimmed = sentence.replace(/\s*\([^()]*\)\s*\.?$/, ".").trim();
    const line = trimmed.length >= 25 ? trimmed : sentence.trim();
    if (line.length <= PURPOSE_LIMIT) {
        return line;
    }
    const clause = /^(.{25,}?)\s*[:;—]\s/.exec(line);
    return clause?.[1] === undefined ? line : `${clause[1]}.`;
};

// The whole explanation, verbatim, not the prose with the row's summary sliced off (purposeOf cuts a parenthetical and
// truncates differently, so slicing would double-print the opening). Nothing beyond the summary ⇒ nothing to disclose.
export const detailOf = (prose: string, purpose: string | undefined): string | undefined => {
    const whole = prose.trim();
    return whole === "" || whole === purpose ? undefined : whole;
};

// Everything below the leading comment: the commands themselves. Comments interleaved with instructions stay, since
// there they explain a specific line.
export const blockCommands = (body: string): string => {
    const lines = body.split("\n");
    const start = lines.findIndex((line) => commentText(line) === undefined && line.trim() !== "");
    return start === -1 ? "" : lines.slice(start).join("\n").trim();
};

// A word that could be a command name. Rules out flags, paths, shell operators and version specs.
const isCommandWord = (word: string): boolean => /^[a-z][a-z0-9+._-]*$/.test(word);

// Joins a shell line continuation into one logical command; matched line by line, an apt package list would read as
// unrelated words.
const unfold = (body: string): string => body.replace(/\\\n\s*/g, " ");

export interface BlockTools {
    // Commands worth asking for a version, best evidence first.
    readonly candidates: string[];
    // Every package installed; whatever isn't a named command is plumbing, counted rather than listed.
    readonly packages: string[];
}

// Which commands a block puts on PATH, from four kinds of evidence, strongest first: an explicit `--version` check, a
// file installed into a bin dir, an npm global's own name, and (weakest) the apt package list.
export const blockTools = (block: OverlayBlock): BlockTools => {
    const body = unfold(block.body);
    const candidates: string[] = [];
    const packages: string[] = [];
    const add = (word: string | undefined): void => {
        if (word !== undefined && isCommandWord(word) && !candidates.includes(word)) {
            candidates.push(word);
        }
    };

    // 1. The block's own verification calls.
    for (const match of body.matchAll(/(?:^|&&|\|\||;)\s*([a-z][a-z0-9+._-]*)\s+(?:--version|-version|version)\b/gm)) {
        add(match[1]);
    }
    // 2. A file installed straight into a bin directory.
    for (const match of body.matchAll(/(?:\/usr\/local\/bin|\/usr\/bin)\/([a-z][a-z0-9+._-]*)/g)) {
        add(match[1]);
    }
    // 3. A globally installed npm package; its command is the last path segment.
    for (const match of body.matchAll(/npm\s+(?:install|i)\s+-g\s+((?:@[^\s@]+\/)?[^\s@]+)/g)) {
        add(match[1]?.split("/").at(-1));
    }
    // 4. The apt package list: weak alone, but catches the common single-package block; stops at the next &&.
    for (const match of body.matchAll(/apt-get\s+install\s+([^&\n]*)/g)) {
        for (const word of (match[1] ?? "").split(/\s+/)) {
            if (isCommandWord(word) && !packages.includes(word)) {
                packages.push(word);
                add(word);
            }
        }
    }
    // The name is a candidate too, and a good one: the agent named the draft file after what it wanted.
    add(block.name.toLowerCase());
    return { candidates, packages };
};
