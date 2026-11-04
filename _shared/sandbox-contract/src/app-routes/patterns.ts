// THE PATH PATTERNS OF THE APP'S ADDRESSES, read and written by one small grammar: the subset of vue-router's that the
// route table (pages.ts) uses. Pure, so the daemon's push messages, the extension API and the native bridges can build
// and read an address without the router.
//
// A pattern is `/`-separated segments. A segment is static text or one parameter: `:name`, optionally a regex in
// parentheses (`(.*)` lets the value hold slashes; an alternation like `(chat|terminal)` names the values it takes),
// then a modifier: `?` optional, `*` zero or more segments, `+` one or more.

/** A parameter's values by name. A value that spans segments (a file's path, a repeatable parameter) holds its slashes. */
export type Params = Readonly<Record<string, string | undefined>>;

interface StaticPart {
    readonly kind: `static`;
    readonly text: string;
}

interface ParamPart {
    readonly kind: `param`;
    readonly name: string;
    /** The value may run over several segments: `(.*)`, or a repeatable modifier. */
    readonly spans: boolean;
    readonly optional: boolean;
    /** The source of an explicit regex other than `.*`, an alternation of the values it takes. */
    readonly choices?: string;
}

type Part = StaticPart | ParamPart;

const PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?([?*+])?$/;

const parse = (pattern: string): readonly Part[] =>
    pattern
        .split(`/`)
        .filter((segment) => segment !== ``)
        .map((segment): Part => {
            const param = PARAM.exec(segment);
            if (param === null) {
                return { kind: `static`, text: segment };
            }
            const [, name = ``, regex, modifier] = param;
            const repeat = modifier === `*` || modifier === `+`;
            const part: ParamPart = { kind: `param`, name, spans: repeat || regex === `.*`, optional: modifier === `?` || modifier === `*` };
            return regex === undefined || regex === `.*` ? part : { ...part, choices: regex };
        });

const cache = new Map<string, readonly Part[]>();
const partsOf = (pattern: string): readonly Part[] => {
    let parts = cache.get(pattern);
    if (parts === undefined) {
        parts = parse(pattern);
        cache.set(pattern, parts);
    }
    return parts;
};

/** The names of a pattern's parameters, in order. */
export const paramNames = (pattern: string): readonly string[] =>
    partsOf(pattern).flatMap((part) => (part.kind === `param` ? [part.name] : []));

// A segment's text encoded as a path may carry it: what URI syntax reserves is escaped, while `:`, `@` and `,` (legal in
// a path segment, and in tab keys like `app:shop/web`) stay readable.
const encodeSegment = (text: string): string => encodeURIComponent(text).replace(/%3A/gi, `:`).replace(/%40/g, `@`).replace(/%2C/gi, `,`);

const segmentsOf = (value: string): readonly string[] => value.split(`/`).filter((segment) => segment !== ``);

/**
 * The address a pattern names with these values, without a leading slash: each segment percent-encoded, a spanning
 * value's slashes kept. Throws on a required parameter left out, since a link that silently drops one opens a page
 * the reader did not ask for.
 */
export const fillPattern = (pattern: string, params: Params = {}): string => {
    const out: string[] = [];
    for (const part of partsOf(pattern)) {
        if (part.kind === `static`) {
            out.push(part.text);
            continue;
        }
        const value = params[part.name];
        const segments = value === undefined ? [] : part.spans ? segmentsOf(value) : [value];
        if (segments.length === 0 || segments[0] === ``) {
            if (!part.optional) {
                throw new Error(`The address ${pattern} needs its :${part.name}.`);
            }
            continue;
        }
        out.push(segments.map(encodeSegment).join(`/`));
    }
    return out.join(`/`);
};

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`);

const regexCache = new Map<string, RegExp>();
const regexOf = (pattern: string): RegExp => {
    let regex = regexCache.get(pattern);
    if (regex === undefined) {
        const body = partsOf(pattern)
            .map((part) => {
                if (part.kind === `static`) {
                    return `/${escape(part.text)}`;
                }
                const value = part.spans ? `(.+)` : part.choices === undefined ? `([^/]+)` : `(${part.choices})`;
                return part.optional ? `(?:/${value})?` : `/${value}`;
            })
            .join(``);
        regex = new RegExp(`^${body}/?$`);
        regexCache.set(pattern, regex);
    }
    return regex;
};

const decode = (text: string): string => {
    try {
        return decodeURIComponent(text);
    } catch {
        // A stray `%` someone typed is the text it says, not a reason to refuse the address.
        return text;
    }
};

/**
 * The values a path (no query, no hash, with or without its leading slash) gives a pattern's parameters, or undefined
 * when it is not that pattern's. A spanning parameter reads as its decoded segments joined by slashes.
 */
export const matchPattern = (pattern: string, path: string): Record<string, string> | undefined => {
    const normalized = path.startsWith(`/`) ? path : `/${path}`;
    const found = regexOf(pattern).exec(normalized === `/` ? `` : normalized);
    if (found === null) {
        return undefined;
    }
    const params: Record<string, string> = {};
    let at = 1;
    for (const part of partsOf(pattern)) {
        if (part.kind === `static`) {
            continue;
        }
        const raw = found[at];
        at += 1;
        if (raw === undefined) {
            continue;
        }
        params[part.name] = part.spans ? raw.split(`/`).map(decode).join(`/`) : decode(raw);
    }
    return params;
};
