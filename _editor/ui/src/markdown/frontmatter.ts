import { escapeHtml } from "./code.js";

// The `---` fenced block a document may OPEN with: the file's metadata, not its prose. Recognized at offset 0 and
// nowhere else, so a thematic break mid-document stays the rule it looks like. Left to marked, the block renders as
// an `<hr>` plus a setext `<h2>` — the metadata becomes the page's largest heading and its first outline entry.
// Pure TypeScript, no DOM: the HTML it builds is escaped here and sanitized with the rest of the document.

/** One `key: value` line. `values` holds a sequence's items; a scalar is one value, an empty key none. */
export interface FrontmatterField {
    readonly key: string;
    readonly values: readonly string[];
    // Written as a sequence (`[a, b]` or `- a` lines), so a one-item list still reads as a list.
    readonly sequence: boolean;
}

export interface Frontmatter {
    /** Both fences and the newline ending the closer: exactly what to slice off the source. */
    readonly raw: string;
    /** Between the fences, as written. What the shapes `fields` cannot describe are shown as. */
    readonly body: string;
    /** The flat key/value shape, or undefined for anything else (nesting, block scalars, not YAML at all). */
    readonly fields: readonly FrontmatterField[] | undefined;
}

// Exactly three dashes on their own line. A four-dash rule or an indented one opens nothing: Jekyll, Astro, Hugo and
// Obsidian all write the fence this way, and a looser opener would swallow documents that merely start with a rule.
const OPEN = /^---[ \t]*\r?\n/u;
// Global so the search for the closer can start at the opener: every use sets `lastIndex` before exec'ing.
const FENCE = /^---[ \t\r]*$/gmu;

// `key:` followed by end of line or whitespace, so a value's own colon (`url: https://x`) never splits the line.
const KEY = /^([A-Za-z0-9_][\w.-]*):(?:[ \t]+(.*))?$/u;
// A sequence item, at any indentation: `- engineering`.
const ITEM = /^[ \t]*-[ \t]+(.*)$/u;
const COMMENT = /^[ \t]*#/u;
// A value that only announces the lines below it; those lines are text this cannot show as a field.
const BLOCK_SCALAR = /^[|>][+-]?\d*$/u;

const stripQuotes = (value: string): string => {
    const quote = value[0];
    if ((quote !== `"` && quote !== `'`) || value.length < 2 || !value.endsWith(quote)) {
        return value;
    }
    const inner = value.slice(1, -1);
    return quote === `"` ? inner.replaceAll(/\\(["\\])/gu, `$1`) : inner.replaceAll(`''`, `'`);
};

// Splits a flow sequence's items on the commas BETWEEN them: a comma inside a quoted item is part of the item.
const flowItems = (inner: string): string[] => {
    const items: string[] = [];
    let item = ``;
    let quote: string | undefined;
    for (const char of inner) {
        if (quote !== undefined) {
            item += char;
            if (char === quote) {
                quote = undefined;
            }
            continue;
        }
        if (char === `"` || char === `'`) {
            quote = char;
            item += char;
            continue;
        }
        if (char === `,`) {
            items.push(item);
            item = ``;
            continue;
        }
        item += char;
    }
    items.push(item);
    return items.map((piece) => stripQuotes(piece.trim())).filter((piece) => piece !== ``);
};

// A scalar, or the items of `[a, b]`. `{}` is a mapping, which this shows as written rather than flattening.
const readValue = (value: string): { readonly values: string[]; readonly sequence: boolean } | undefined => {
    if (BLOCK_SCALAR.test(value)) {
        return undefined;
    }
    if (value.startsWith(`[`) && value.endsWith(`]`)) {
        return { values: flowItems(value.slice(1, -1)), sequence: true };
    }
    return { values: value === `` ? [] : [stripQuotes(value)], sequence: false };
};

// A sequence item belongs to the key above it, which has to have been left open — no value, or items already.
const appendItem = (fields: FrontmatterField[], text: string): boolean => {
    const open = fields.at(-1);
    if (open === undefined || (open.values.length > 0 && !open.sequence)) {
        return false;
    }
    fields[fields.length - 1] = { key: open.key, values: [...open.values, stripQuotes(text)], sequence: true };
    return true;
};

const appendField = (fields: FrontmatterField[], line: string): boolean => {
    const match = KEY.exec(line);
    const value = match === null ? undefined : readValue((match[2] ?? ``).trim());
    if (match === null || value === undefined) {
        return false;
    }
    fields.push({ key: match[1] ?? ``, values: value.values, sequence: value.sequence });
    return true;
};

// An indented plain line wraps the scalar above it, joined with the space YAML folds it to — the shape a long
// `description:` takes by hand. A `key: value` under a key is a nested map instead, which has no row to render into.
const appendWrap = (fields: FrontmatterField[], text: string): boolean => {
    const open = fields.at(-1);
    if (open === undefined || open.sequence || open.values.length !== 1 || KEY.test(text)) {
        return false;
    }
    fields[fields.length - 1] = { key: open.key, values: [`${open.values[0] ?? ``} ${text}`], sequence: false };
    return true;
};

// One line onto the fields so far. False for anything a two-column grid cannot state.
const readLine = (fields: FrontmatterField[], line: string): boolean => {
    const item = ITEM.exec(line);
    if (item !== null) {
        return appendItem(fields, (item[1] ?? ``).trim());
    }
    return line === line.trimStart() ? appendField(fields, line) : appendWrap(fields, line.trim());
};

// The block as fields, or undefined the moment a line is something this cannot show as one — a nested map, a block
// scalar, a bare line. Degrading whole rather than per line: half a parse of somebody's metadata is worse than none.
const readFields = (body: string): FrontmatterField[] | undefined => {
    const fields: FrontmatterField[] = [];
    for (const raw of body.split(`\n`)) {
        const line = raw.replace(/\r$/u, ``);
        if (line.trim() === `` || COMMENT.test(line)) {
            continue;
        }
        if (!readLine(fields, line)) {
            return undefined;
        }
    }
    return fields;
};

/** The leading metadata block and the document after it, or undefined when the source does not open with one. */
export const splitFrontmatter = (source: string): { readonly matter: Frontmatter; readonly rest: string } | undefined => {
    const opener = OPEN.exec(source);
    if (opener === null) {
        return undefined;
    }
    const start = opener[0].length;
    // One scan from the opener, no line array: a chat message that merely BEGINS with a rule re-parses on every
    // streamed delta, and that document has no closer to find.
    FENCE.lastIndex = start;
    const closer = FENCE.exec(source);
    // An unterminated block is not one: the document keeps the rule and the prose marked already gives it.
    if (closer === null) {
        return undefined;
    }
    const after = closer.index + closer[0].length;
    const raw = source.slice(0, source[after] === `\n` ? after + 1 : after);
    const body = source.slice(start, closer.index);
    return { matter: { raw, body, fields: readFields(body) }, rest: source.slice(raw.length) };
};

const valueHtml = (field: FrontmatterField): string =>
    field.sequence
        ? field.values.map((value) => `<span class="md-fm-item">${escapeHtml(value)}</span>`).join(``)
        : escapeHtml(field.values[0] ?? ``);

/** The block as the document's header. Empty string for metadata with nothing in it, which draws no header at all. */
export const frontmatterHtml = (matter: Frontmatter): string => {
    const fields = matter.fields;
    if (fields === undefined) {
        // Shown as written, in the file's own line breaks: the alternative is guessing at a shape and printing it wrong.
        return `<div class="md-frontmatter"><pre class="md-fm-source">${escapeHtml(matter.body.replace(/\n$/u, ``))}</pre></div>`;
    }
    if (fields.length === 0) {
        return ``;
    }
    const rows = fields.map((field) => `<dt>${escapeHtml(field.key)}</dt><dd>${valueHtml(field)}</dd>`).join(``);
    return `<div class="md-frontmatter"><dl>${rows}</dl></div>`;
};
