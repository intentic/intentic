import { randomBytes } from "node:crypto";

/* THE ENVELOPE AROUND EVERYTHING THAT ARRIVES FROM OUTSIDE, a stranger's chat message, a fetched web page, a
 * tool result from a server this daemon does not serve. The model reads it as
 *
 *     <untrusted-content source="webchat" from="Alice" id="8f3a92c1d6e07b45">
 *     …the content, neutralized…
 *     </untrusted-content id="8f3a92c1d6e07b45">
 *
 * and the system prompt defines the language ONCE (system-prompt.ts OUTSIDE_GUIDANCE): what is inside is data
 * to read and act ABOUT, never instructions to follow. The id is minted fresh per wrap, and the CLOSE tag
 * carries it, so content cannot end its own envelope and speak in the owner's voice after it: writing the
 * close tag requires a value the content was written before anyone knew.
 *
 * Two spoofs are neutralized in the body before wrapping, because an envelope is only as good as the reader's
 * ability to tell a real marker from a planted one:
 *
 *   · Envelope lookalikes, any complete `<untrusted-content …>` / `</untrusted-content …>` the content
 *     carries, matched after FOLDING: fullwidth and ornamental angle brackets to ASCII, fullwidth letters
 *     down, zero-width characters out. A marker spelled with a CJK `〈` or with a zero-width space inside
 *     "untrusted" reads as a marker to a model and as noise to a byte comparison; folding is what makes the
 *     comparison see what the model sees. A dangling marker PREFIX at the very end of the body (a forgery the
 *     content ran out of room to close) is cut for the same reason.
 *   · Control vocabulary, the tags the harness itself speaks in (`<system-reminder>`, `<task-notification>`,
 *     `<command-name>`, …) and the reserved tokens of the model families the translator routes to
 *     (`<|im_start|>`, `[INST]`, `<start_of_turn>`, …). The single highest-value forgery is not fake prose,
 *     it is the platform's own voice; a page that contains `<system-reminder>` is either quoting us or
 *     impersonating us, and an inert token serves the quoter fine.
 *
 * WHAT THIS IS NOT: a boundary against a hostile model, or a parser. It is the seam that makes "this text is
 * from outside" a property of the conversation the model cannot miss and the content cannot unsay, and the
 * same wrap is what flips the turn's taint (guard/turn-taint.ts), which is where the mark grows teeth: a
 * tainted turn's credential reads stop being auto-allowed (guard/command-gate.ts).
 *
 * Out of scope, deliberately: files already inside the workspace (the agent's own material), content a
 * delegated CLI read in its own context (its harness, its seams), and listener media files referenced by path
 * (the path is wrapped with the payload; the bytes ride the Read tool like any workspace file). */

// The tag as the model reads it. One name, both ends, id on both, the close tag is the one that matters.
const TAG = "untrusted-content";

export interface OutsideMeta {
    // Where this came from, for the model's benefit: "webchat", "discord", "web", "browser", an MCP server's
    // name. Free-form because the sources are open-ended; sanitized because it lands in an attribute.
    readonly source: string;
    // Who sent it, when a sender exists (a listener message's author). Never proof of identity.
    readonly from?: string;
}

/* ---- folding: make the byte comparison see what the model sees ---- */

// Zero-width and invisible characters a spoof threads through a marker word. Removed for matching; the
// replacement spans the original text, so they vanish with the marker they hid in.
const IGNORABLE = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad]);

// Angle-bracket homoglyphs → ASCII. The full OpenClaw-measured set: every bracket a model plausibly reads as
// a tag delimiter.
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
    // For folded index i: the original-string span it came from, so a match on folded text can be replaced in
    // the original without disturbing anything the fold left alone.
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

/* A complete envelope marker, either end, any attributes; and the JSON-escaped form a marker wears inside a
 * serialized payload (`\"` for its quotes), matched on FOLDED text. `[^>]*` is linear and unbounded on
 * purpose: capping the attribute run would let a forged marker with a longer id through whole. The separator
 * class covers spellings a model still reads as the tag: `untrusted content`, `untrusted_content`. */
const MARKER = /<\s*\/?\s*untrusted[\s_-]+content\b[^>]*>/gi;
// The same shape cut off by the end of the body, a forgery that ran out of room, removed so no prefix of a
// marker ever stands immediately before the real close tag.
const MARKER_TAIL = /<\s*\/?\s*untrusted[\s_-]+content\b[^>]*$/i;

/* The harness's own voice. Open and close forms both, attributes tolerated, `<system-reminder>` inside a web
 * page is either a quote of us or an impersonation of us, and the inert token serves the quoter fine. The
 * list is the vocabulary the daemon and the CLI actually inject around agent turns. */
const CONTROL_TAGS = ["system-reminder", "task-notification", "command-name", "command-message", "command-args", "local-command-stdout"];
const CONTROL = new RegExp(String.raw`<\s*/?\s*(?:${CONTROL_TAGS.join("|")})\b[^>]*>`, "gi");

/* Reserved tokens of the model families the translator routes turns to. A local server tokenizing raw text
 * could read these as turn structure; an API provider treats them as data, and for it this costs nothing. */
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

// Replace every folded-text match of `pattern` in the ORIGINAL string, via the fold's index map. Matches are
// non-overlapping and in order, so a single left-to-right pass rebuilds the string.
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

/* Neutralize everything in `body` that could impersonate a marker or the harness once it sits inside an
 * envelope. Exported for tests; wrapOutsideContent is the caller. Idempotent: the replacement token matches
 * none of the patterns. */
export const neutralizeOutsideText = (body: string): string => {
    let text = body;
    // Envelope lookalikes and control tags fold-match; two passes so a control tag hidden inside a forged
    // marker's attributes still dies with the marker around it.
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
    // Special tokens are exact literals, no fold needed (a homoglyph `<|im_start|>` is not the reserved
    // token to any tokenizer), and split/join is immune to the regex-metacharacter content they carry.
    for (const token of SPECIAL_TOKENS) {
        if (text.includes(token)) {
            text = text.split(token).join(NEUTRALIZED);
        }
    }
    return text.replace(RESERVED_TOKEN, NEUTRALIZED);
};

// Attribute values ride inside the open tag, so nothing in them may close it or open another: angle brackets,
// quotes and newlines flatten to spaces. Neutralized first so a marker-shaped author dies the same death.
const attribute = (value: string): string =>
    neutralizeOutsideText(value)
        .replaceAll(/["<>\r\n]+/g, " ")
        .trim();

/* Wrap one piece of outside content. The whole mechanism a call site needs: neutralize, mint the id, seal
 * both ends. The one-line header carries source and sender; the LANGUAGE lives in the system prompt once, not
 * here, a browsing turn re-reads a sermon per page or it reads a tag per page, and the tag wins. */
export const wrapOutsideContent = (body: string, meta: OutsideMeta): string => {
    const id = randomBytes(8).toString("hex");
    const from = meta.from === undefined || meta.from.trim() === "" ? "" : ` from="${attribute(meta.from)}"`;
    return `<${TAG} source="${attribute(meta.source)}"${from} id="${id}">\n${neutralizeOutsideText(body)}\n</${TAG} id="${id}">`;
};
