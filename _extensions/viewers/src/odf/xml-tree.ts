/* XML as a plain tree: no DOMParser, so the same parse runs on the main thread, in the sheet worker (which has no
   DOM) and in a node test. */

// ODF namespace URIs to the prefix this code uses. A file may bind any prefix it likes to these URIs, so tags are
// keyed by the URI's canonical prefix here, never by the prefix the file happened to write.
const CANONICAL: Readonly<Record<string, string>> = {
    "urn:oasis:names:tc:opendocument:xmlns:office:1.0": `office`,
    "urn:oasis:names:tc:opendocument:xmlns:style:1.0": `style`,
    "urn:oasis:names:tc:opendocument:xmlns:text:1.0": `text`,
    "urn:oasis:names:tc:opendocument:xmlns:table:1.0": `table`,
    "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0": `draw`,
    "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0": `presentation`,
    "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0": `fo`,
    "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0": `svg`,
    "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0": `number`,
    "urn:oasis:names:tc:opendocument:xmlns:meta:1.0": `meta`,
    "urn:oasis:names:tc:opendocument:xmlns:chart:1.0": `chart`,
    "http://purl.org/dc/elements/1.1/": `dc`,
    "http://www.w3.org/1999/xlink": `xlink`,
    "http://www.idpf.org/2007/opf": `opf`,
    "urn:oasis:names:tc:opendocument:xmlns:container": `container`,
    "http://www.idpf.org/2007/ops": `epub`,
    "http://www.w3.org/1999/xhtml": `html`,
    "http://www.daisy.org/z3986/2005/ncx/": `ncx`,
};

export interface XmlElement {
    /** `prefix:local` with the CANONICAL prefix above, or bare `local` for a tag in no namespace. */
    readonly tag: string;
    readonly attrs: ReadonlyMap<string, string>;
    readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElement | { readonly text: string };

export const isElement = (node: XmlNode): node is XmlElement => `tag` in node;

const ENTITIES: Readonly<Record<string, string>> = { amp: `&`, lt: `<`, gt: `>`, quot: `"`, apos: `'`, nbsp: ` ` };

const codePoint = (body: string): string | undefined => {
    const code = body.startsWith(`#x`) || body.startsWith(`#X`) ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
};

/** XML's five predefined entities plus numeric character references; anything else is left as written. */
export const decodeEntities = (text: string): string =>
    text.includes(`&`)
        ? text.replaceAll(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) =>
              body.startsWith(`#`) ? (codePoint(body) ?? whole) : (ENTITIES[body] ?? whole),
          )
        : text;

interface Frame {
    readonly tag: string;
    readonly attrs: ReadonlyMap<string, string>;
    readonly children: XmlNode[];
    readonly scope: ReadonlyMap<string, string>;
}

const EMPTY_SCOPE: ReadonlyMap<string, string> = new Map();
const NAME_END = /[\s/>]/;

// A prefix bound to nothing resolves to itself, so an unbound `foo:bar` stays distinguishable from a bare `bar`.
const qualify = (name: string, scope: ReadonlyMap<string, string>, isAttribute: boolean): string => {
    const colon = name.indexOf(`:`);
    if (colon === -1) {
        // An unprefixed ATTRIBUTE is in no namespace even under a default xmlns; only elements take the default.
        const uri = isAttribute ? undefined : scope.get(``);
        const prefix = uri === undefined ? undefined : CANONICAL[uri];
        return prefix === undefined ? name : `${prefix}:${name}`;
    }
    const uri = scope.get(name.slice(0, colon));
    return uri === undefined ? name : `${CANONICAL[uri] ?? uri}:${name.slice(colon + 1)}`;
};

// Index just past `marker`, or the end of input when it never closes.
const after = (source: string, from: number, marker: string): number => {
    const end = source.indexOf(marker, from);
    return end === -1 ? source.length : end + marker.length;
};

// Comment, CDATA, prolog or doctype: everything that starts with `<` and is not a tag. -1 means "this is a tag".
const skipNonElement = (source: string, open: number, emit: (text: string) => void): number => {
    if (source.startsWith(`<!--`, open)) {
        return after(source, open, `-->`);
    }
    if (source.startsWith(`<![CDATA[`, open)) {
        const end = after(source, open, `]]>`);
        emit(source.slice(open + 9, Math.max(open + 9, end - 3)));
        return end;
    }
    if (source.startsWith(`<?`, open) || source.startsWith(`<!`, open)) {
        return after(source, open, `>`);
    }
    return -1;
};

interface AttributePair {
    readonly name?: string;
    readonly value?: string;
    readonly next: number;
}

const readPair = (source: string, cursor: number): AttributePair => {
    const gt = source.indexOf(`>`, cursor);
    const stop = gt === -1 ? source.length : gt;
    const equals = source.indexOf(`=`, cursor);
    if (equals === -1 || equals > stop) {
        return { next: stop };
    }
    const quote = source[equals + 1];
    const end = quote === `"` || quote === `'` ? source.indexOf(quote, equals + 2) : -1;
    if (end === -1) {
        return { next: stop };
    }
    return { name: source.slice(cursor, equals).trim(), value: decodeEntities(source.slice(equals + 2, end)), next: end + 1 };
};

interface StartTag {
    readonly raw: readonly (readonly [string, string])[];
    readonly scope: ReadonlyMap<string, string>;
    readonly selfClosing: boolean;
    readonly next: number;
}

const skipSpace = (source: string, from: number): number => {
    let cursor = from;
    while (/\s/.test(source[cursor] ?? ``)) {
        cursor += 1;
    }
    return cursor;
};

// One attribute lands either in the element's namespace bindings or among its attributes, never both.
const store = (pair: AttributePair, raw: [string, string][], bound: Map<string, string>): void => {
    if (pair.name === undefined || pair.value === undefined) {
        return;
    }
    if (pair.name === `xmlns`) {
        bound.set(``, pair.value);
        return;
    }
    if (pair.name.startsWith(`xmlns:`)) {
        bound.set(pair.name.slice(6), pair.value);
        return;
    }
    raw.push([pair.name, pair.value]);
};

const readAttributes = (source: string, start: number, inherited: ReadonlyMap<string, string>): StartTag => {
    const raw: [string, string][] = [];
    const bound = new Map<string, string>();
    let selfClosing = false;
    let cursor = start;
    while (cursor < source.length) {
        cursor = skipSpace(source, cursor);
        // End of input reads as the end of the tag, so a truncated file cannot spin here.
        const char = source[cursor] ?? `>`;
        if (char === `>`) {
            cursor += 1;
            break;
        }
        if (char === `/`) {
            selfClosing = true;
            cursor += 1;
            continue;
        }
        const pair = readPair(source, cursor);
        cursor = pair.next;
        store(pair, raw, bound);
    }
    return { raw, scope: bound.size === 0 ? inherited : new Map([...inherited, ...bound]), selfClosing, next: cursor };
};

/**
 * The document element, or undefined for input holding no element at all. A malformed tail keeps what parsed rather
 * than throwing: half a spreadsheet beats an error page.
 */
export const parseXml = (source: string): XmlElement | undefined => {
    const stack: Frame[] = [];
    let root: XmlElement | undefined;
    let position = 0;

    const push = (element: XmlElement): void => {
        const parent = stack.at(-1);
        if (parent === undefined) {
            root ??= element;
            return;
        }
        parent.children.push(element);
    };
    const emit = (text: string): void => void stack.at(-1)?.children.push({ text });
    const close = (): void => {
        const frame = stack.pop();
        if (frame !== undefined) {
            push({ tag: frame.tag, attrs: frame.attrs, children: frame.children });
        }
    };

    while (position < source.length) {
        const open = source.indexOf(`<`, position);
        if (open === -1) {
            break;
        }
        if (open > position) {
            emit(decodeEntities(source.slice(position, open)));
        }
        const skipped = skipNonElement(source, open, emit);
        if (skipped !== -1) {
            position = skipped;
            continue;
        }
        if (source.startsWith(`</`, open)) {
            close();
            position = after(source, open, `>`);
            continue;
        }
        position = readStartTag(source, open, stack, push);
    }
    // Tags still open at EOF are closed in order, so a truncated file still renders what it did contain.
    while (stack.length > 0) {
        close();
    }
    return root;
};

const readStartTag = (source: string, open: number, stack: Frame[], push: (element: XmlElement) => void): number => {
    let cursor = open + 1;
    while (cursor < source.length && !NAME_END.test(source[cursor] ?? `>`)) {
        cursor += 1;
    }
    const rawName = source.slice(open + 1, cursor);
    const tag = readAttributes(source, cursor, stack.at(-1)?.scope ?? EMPTY_SCOPE);
    const attrs = new Map(tag.raw.map(([name, value]) => [qualify(name, tag.scope, true), value]));
    const name = qualify(rawName, tag.scope, false);
    if (tag.selfClosing) {
        push({ tag: name, attrs, children: [] });
    } else {
        stack.push({ tag: name, attrs, children: [], scope: tag.scope });
    }
    return tag.next;
};

// Takes an absent element, since most reads are of an optional child and `attr(child(x, y), z)` is the whole idiom.
export const attr = (element: XmlElement | undefined, name: string): string | undefined => element?.attrs.get(name);

export const childElements = (element: XmlElement): XmlElement[] => element.children.filter((node) => isElement(node));

/** The first child with this tag, one level down. */
export const child = (element: XmlElement, tag: string): XmlElement | undefined =>
    element.children.find((node): node is XmlElement => isElement(node) && node.tag === tag);

/** Every descendant with this tag, in document order, the subtree root included. */
export const descendants = (element: XmlElement, tag: string): XmlElement[] => {
    const found: XmlElement[] = [];
    const walk = (node: XmlElement): void => {
        if (node.tag === tag) {
            found.push(node);
        }
        for (const kid of node.children) {
            if (isElement(kid)) {
                walk(kid);
            }
        }
    };
    walk(element);
    return found;
};

/** The first descendant with this tag, or undefined. */
export const descendant = (element: XmlElement, tag: string): XmlElement | undefined => descendants(element, tag)[0];

/** All text under an element, concatenated; markup contributes nothing. */
export const textOf = (element: XmlElement): string => element.children.map((node) => (isElement(node) ? textOf(node) : node.text)).join(``);
