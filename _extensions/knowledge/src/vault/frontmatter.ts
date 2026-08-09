/* THE FRONTMATTER SUBSET A VAULT NOTE IS ALLOWED TO USE, and its total parser.
 *
 * Deliberately not YAML. Three reasons, in order of how much they cost:
 *
 * 1. THE AGENT WRITES THESE FILES. Full YAML has a dozen ways to mean the same thing and several ways to mean
 *    something else entirely — `no` is false, `2026-08-09` is a Date, `1.0` is a number and `1.0.0` is a string,
 *    an unquoted `[[Ada]]` is a nested sequence. A knowledge note's fields are names of things, and a format
 *    that silently turns the name of a thing into a boolean is a format that loses facts.
 * 2. A MALFORMED HEADER MUST DEGRADE, NEVER THROW. This runs inside a render and inside a CLI the agent calls
 *    mid-task; a hand-edited note with one stray character must cost that note its chips, not the panel.
 * 3. It keeps the CLI and the backend bundles small and dependency-free.
 *
 * So: keys map to STRINGS, and every value is normalised to an array of them — one shape for the whole index,
 * so nothing downstream has to ask whether `tags` came back as a scalar or a list. What is understood:
 *
 *     type: person                     a scalar
 *     title: "Ada Lovelace"            quoted, when the value has a colon or leading spaces in it
 *     aliases: [Ada, "Countess"]       a flow list
 *     tags:                            a block list
 *       - colleague
 *       - math
 *     works_on: ["[[Intentic]]"]       links are ordinary strings — see note.ts for what makes one a relation
 *
 * Anything else in the header — a nested map, an anchor, a multi-line scalar — is SKIPPED rather than guessed
 * at, and `kb check` reports the keys it could not read so a note never fails silently. */

// The `---` fenced header, at the very top of the file. \r\n tolerated: these files round-trip through editors.
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface Frontmatter {
    // Every key that parsed, in file order, each as a list (a scalar is a list of one).
    readonly fields: ReadonlyMap<string, readonly string[]>;
    // Keys present in the header that this parser does not understand — surfaced by `kb check`, never thrown.
    readonly unreadable: readonly string[];
    // The note without its header. What gets rendered and what a body-link scan reads.
    readonly body: string;
    // Whether there was a header at all — an empty one and a missing one are different things to report on.
    readonly present: boolean;
}

// A scalar value: quotes stripped, a trailing `# comment` left ALONE. Tags are written `#colleague` in bodies
// and turn up in values often enough that treating `#` as a comment introducer here would eat real data.
const scalar = (raw: string): string => {
    const value = raw.trim();
    const quoted = /^"(.*)"$/s.exec(value) ?? /^'(.*)'$/s.exec(value);
    return (quoted?.[1] ?? value).trim();
};

// The items of a flow list `[a, "b, still b", c]` — split on commas OUTSIDE quotes, so a quoted item may hold one.
const flowItems = (inner: string): string[] => {
    const items: string[] = [];
    let current = "";
    let quote: string | undefined;
    for (const char of inner) {
        if (quote !== undefined) {
            if (char === quote) {
                quote = undefined;
            }
            current += char;
        } else if (char === '"' || char === "'") {
            quote = char;
            current += char;
        } else if (char === ",") {
            items.push(current);
            current = "";
        } else {
            current += char;
        }
    }
    items.push(current);
    return items.map(scalar).filter((item) => item !== "");
};

const KEY_LINE = /^([A-Za-z_][\w.-]*)[ \t]*:[ \t]*(.*)$/;
const BLOCK_ITEM = /^[ \t]+-[ \t]*(.*)$/;

export const parseFrontmatter = (content: string): Frontmatter => {
    const match = FRONTMATTER.exec(content);
    if (match === null) {
        return { fields: new Map(), unreadable: [], body: content, present: false };
    }
    const fields = new Map<string, string[]>();
    const unreadable: string[] = [];
    const lines = (match[1] ?? "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        // A full-line comment or a blank. Anything indented at this point belongs to a key that has already
        // consumed what it wanted (a block list) or to a shape this parser skipped — either way, not ours.
        if (line.trim() === "" || line.trimStart().startsWith("#") || /^[ \t]/.test(line)) {
            continue;
        }
        const key = KEY_LINE.exec(line);
        if (key === null) {
            continue;
        }
        const name = key[1] ?? "";
        const inline = (key[2] ?? "").trim();
        const flow = /^\[(.*)\]$/s.exec(inline);
        if (flow !== null) {
            fields.set(name, flowItems(flow[1] ?? ""));
            continue;
        }
        if (inline !== "") {
            fields.set(name, [scalar(inline)]);
            continue;
        }
        // A key with nothing after the colon: either a block list under it, or a nested map we cannot read.
        const items: string[] = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
            const next = lines[j] ?? "";
            if (next.trim() === "") {
                continue;
            }
            const item = BLOCK_ITEM.exec(next);
            if (item === null) {
                break;
            }
            const value = scalar(item[1] ?? "");
            if (value !== "") {
                items.push(value);
            }
        }
        if (items.length > 0) {
            fields.set(name, items);
        } else {
            unreadable.push(name);
        }
        i = j - 1;
    }
    return { fields, unreadable, body: content.slice(match[0].length), present: true };
};

/* Write a header back. Used by `kb new` and `kb set`, so the shape the agent produces is the shape this parser
 * reads by construction rather than by the agent remembering it. Order is the caller's — a note reads better
 * with `type` first than alphabetically — and a value is quoted only when leaving it bare would change it.
 *
 * The BODY is passed through untouched. An edit to one field must never reflow somebody's prose. */
const needsQuotes = (value: string): boolean => value === "" || /^[[\-#&*!|>%@`'"]/.test(value) || /:\s|\s#|^\s|\s$/.test(value);

const emit = (value: string): string => (needsQuotes(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value);

export const formatFrontmatter = (fields: ReadonlyMap<string, readonly string[]>, body: string): string => {
    const lines: string[] = [];
    for (const [key, values] of fields) {
        if (values.length === 0) {
            continue;
        }
        // A single value stays a scalar: `type: person` rather than `type: [person]`, because that is what a
        // human writes and what every other vault would render. Multi-valued keys use the flow form, which is
        // one line per key and survives a round trip through this parser unchanged.
        lines.push(values.length === 1 ? `${key}: ${emit(values[0] ?? "")}` : `${key}: [${values.map(emit).join(", ")}]`);
    }
    // No blank line after the fence, and that is a contract rather than a preference: `parseFrontmatter` stops
    // at the fence, so anything written past it IS body — and a writer that added a courtesy newline would make
    // every round trip through these two functions grow the note by one.
    return `---\n${lines.join("\n")}\n---\n${body.replace(/^\n+/, "")}`;
};
