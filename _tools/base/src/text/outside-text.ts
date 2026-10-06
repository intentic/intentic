// Wraps outside content (chat, pages, tool results) in `<untrusted-content id=...>` tags; the close tag's id is fresh
// per wrap, so content cannot forge its own close. Neutralizes envelope lookalikes and the harness's control tags in
// the body first. Not a boundary against a hostile model, only a taint marker.

// One tag name both ends; the id on the close tag is what a forgery can't reproduce.
const TAG = "untrusted-content";

export interface OutsideMeta {
    // Where this came from ("webchat", "discord", an MCP server's name); free-form, sanitized for an attribute.
    readonly source: string;
    // Who sent it, when a sender exists (a listener message's author). Never proof of identity.
    readonly from?: string;
}

/* ---- folding: make the byte comparison see what the model sees ---- */

// Invisible characters a spoof threads through a marker word; stripped before matching, so they vanish with it.
const IGNORABLE = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad]);

// Angle-bracket homoglyphs folded to ASCII: every bracket a model plausibly reads as a tag delimiter.
const ANGLE: Record<number, string> = {
    0xff1c: "<",
    0xff1e: ">",
    0x2329: "<",
    0x232a: ">",
    0x3008: "<",
    0x3009: ">",
    0x2039: "<",
    0x203a: ">",
    0x27e8: "<",
    0x27e9: ">",
    0xfe64: "<",
    0xfe65: ">",
    0x00ab: "<",
    0x00bb: ">",
    0x300a: "<",
    0x300b: ">",
    0x27ea: "<",
    0x27eb: ">",
    0x27ec: "<",
    0x27ed: ">",
    0x27ee: "<",
    0x27ef: ">",
    0x276c: "<",
    0x276d: ">",
    0x276e: "<",
    0x276f: ">",
    0x02c2: "<",
    0x02c3: ">",
};

const FULLWIDTH_OFFSET = 0xfee0;

const foldChar = (code: number): string | undefined => {
    // Fullwidth A–Z / a–z down to ASCII.
    if ((code >= 0xff21 && code <= 0xff3a) || (code >= 0xff41 && code <= 0xff5a)) {
        return String.fromCharCode(code - FULLWIDTH_OFFSET);
    }
    return ANGLE[code];
};

interface Folded {
    readonly text: string;
    // For folded index i, the original-string span it came from, so a folded-text match maps back to the original.
    readonly starts: readonly number[];
    readonly ends: readonly number[];
}

const fold = (input: string): Folded => {
    let text = "";
    const starts: number[] = [];
    const ends: number[] = [];
    for (let i = 0; i < input.length; i++) {
        const code = input.charCodeAt(i);
        if (IGNORABLE.has(code)) {
            continue;
        }
        text += foldChar(code) ?? input[i];
        starts.push(i);
        ends.push(i + 1);
    }
    return { text, starts, ends };
};

/* ---- what gets neutralized ---- */

export const NEUTRALIZED = "[marker removed]";

// A complete envelope marker, either end; `[^>]*` is unbounded so a longer forged id cannot slip past it.
const MARKER = /<\s*\/?\s*untrusted[\s_-]+content\b[^>]*>/gi;
// Same shape cut off at the body's end; no marker prefix may sit immediately before a real close tag.
const MARKER_TAIL = /<\s*\/?\s*untrusted[\s_-]+content\b[^>]*$/i;

// The harness's own tags; a page with one is quoting or impersonating it, and an inert token serves either.
const CONTROL_TAGS = ["system-reminder", "task-notification", "command-name", "command-message", "command-args", "local-command-stdout"];
const CONTROL = new RegExp(String.raw`<\s*/?\s*(?:${CONTROL_TAGS.join("|")})\b[^>]*>`, "gi");

// Reserved tokens a local server could read as turn structure; an API provider treats them as data, at no cost.
const SPECIAL_TOKENS = [
    "<|im_start|>",
    "<|im_end|>",
    "<|endoftext|>",
    "<|begin_of_text|>",
    "<|end_of_text|>",
    "<|start_header_id|>",
    "<|end_header_id|>",
    "<|eot_id|>",
    "<|python_tag|>",
    "<|eom_id|>",
    "[INST]",
    "[/INST]",
    "<<SYS>>",
    "<</SYS>>",
    "<s>",
    "</s>",
    "<|channel|>",
    "<|message|>",
    "<|return|>",
    "<|call|>",
    "<start_of_turn>",
    "<end_of_turn>",
];
const RESERVED_TOKEN = /<\|reserved_special_token_\d+\|>/g;

// Replaces every folded-text match of `pattern` in the original string via the fold's index map, in one left-to-right
// pass.
const replaceFolded = (original: string, folded: Folded, pattern: RegExp): string => {
    pattern.lastIndex = 0;
    let out = "";
    let cursor = 0;
    for (const match of folded.text.matchAll(pattern)) {
        const start = folded.starts[match.index] ?? match.index;
        const last = match.index + match[0].length - 1;
        const end = folded.ends[last] ?? last + 1;
        if (start < cursor) {
            continue;
        }
        out += original.slice(cursor, start) + NEUTRALIZED;
        cursor = end;
    }
    return out + original.slice(cursor);
};

// Neutralizes anything in `body` that could impersonate a marker or the harness inside an envelope; idempotent, since
// the replacement token matches none of the patterns.
export const neutralizeOutsideText = (body: string): string => {
    let text = body;
    // Two passes: a control tag hidden inside a forged marker's attributes still dies with the marker around it.
    for (const pattern of [MARKER, CONTROL]) {
        const folded = fold(text);
        pattern.lastIndex = 0;
        if (pattern.test(folded.text)) {
            text = replaceFolded(text, folded, pattern);
        }
        pattern.lastIndex = 0;
    }
    {
        const folded = fold(text);
        const tail = MARKER_TAIL.exec(folded.text);
        if (tail !== null) {
            text = text.slice(0, folded.starts[tail.index] ?? tail.index) + NEUTRALIZED;
        }
    }
    // Exact literals, no folding needed; split/join avoids the regex metacharacters these tokens carry.
    for (const token of SPECIAL_TOKENS) {
        if (text.includes(token)) {
            text = text.split(token).join(NEUTRALIZED);
        }
    }
    return text.replace(RESERVED_TOKEN, NEUTRALIZED);
};

// Attribute values ride inside the open tag, so angle brackets, quotes and newlines flatten to spaces; neutralized
// first, same as the body.
const attribute = (value: string): string =>
    neutralizeOutsideText(value)
        .replaceAll(/["<>\r\n]+/g, " ")
        .trim();

// Neutralizes, mints the id and seals both ends; the header carries source and sender only, the rules for reading it
// live in the system prompt once, not per page.
export const wrapOutsideContent = (body: string, meta: OutsideMeta): string => {
    // Web Crypto, not node:crypto: this module is shared by every tier, including a possible browser.
    const id = [...globalThis.crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const from = meta.from === undefined || meta.from.trim() === "" ? "" : ` from="${attribute(meta.from)}"`;
    return `<${TAG} source="${attribute(meta.source)}"${from} id="${id}">\n${neutralizeOutsideText(body)}\n</${TAG} id="${id}">`;
};
