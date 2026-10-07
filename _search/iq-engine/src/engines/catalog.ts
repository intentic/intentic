import { readFile } from "node:fs/promises";
import type { FileEntry } from "../types.js";

// Translation catalogs: the JSON files a UI's text actually lives in. A screenshot shows that text, so an agent searches
// for it; in an i18n'd app the component that renders it never contains it, only its dotted key (`t('a.b.c')`). This
// module finds which catalog entry a piece of UI text is, so the caller can look the key up in code.

export interface CatalogEntry {
    // The full dotted path of nested keys down to this string, the form `t()` takes.
    readonly key: string;
    // The line the string value starts on, 1-based.
    readonly line: number;
    readonly value: string;
}

export interface Catalog {
    readonly path: string;
    // `en`, `pl`, `en-US`: from the file name, or from its directory for one-folder-per-locale layouts.
    readonly locale: string | undefined;
    readonly entries: readonly CatalogEntry[];
}

// Directory names translation catalogs live under across the usual i18n stacks (vue-i18n, i18next, next-intl, Rails).
const CATALOG_DIRS = new Set(["i18n", "l10n", "locales", "locale", "lang", "langs", "languages", "translations", "messages"]);
const LOCALE_CODE = /^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/;

// A JSON file under a catalog directory. The shape check is the path alone: parsing every JSON file in a workspace to
// ask whether it looks like a catalog would cost a read per file per query.
export const isCatalogPath = (path: string): boolean => {
    if (!path.endsWith(".json")) {
        return false;
    }
    return path.split("/").slice(0, -1).some((segment) => CATALOG_DIRS.has(segment.toLowerCase()));
};

// The source tree a catalog's keys are used in: up to its nearest `src/` (`_editor/web/src/` for
// `_editor/web/src/app/i18n/locales/en.json`), else the folder holding its catalog folder.
export const catalogHome = (path: string): string => {
    const parts = path.split("/");
    const catalogDir = parts.findIndex((segment, index) => index < parts.length - 1 && CATALOG_DIRS.has(segment.toLowerCase()));
    const src = parts.slice(0, Math.max(catalogDir, 0)).lastIndexOf("src");
    const end = src !== -1 ? src + 1 : Math.max(catalogDir, 0);
    return parts.slice(0, end).map((segment) => `${segment}/`).join("");
};

export const localeOf = (path: string): string | undefined => {
    const parts = path.split("/");
    const base = (parts.at(-1) ?? "").replace(/\.json$/, "");
    if (LOCALE_CODE.test(base)) {
        return base;
    }
    const parent = parts.at(-2) ?? "";
    return LOCALE_CODE.test(parent) ? parent : undefined;
};

// English first: an untranslated string sits in every locale verbatim, and the reader wants the source one.
export const isEnglish = (locale: string | undefined): boolean => locale === "en" || locale?.startsWith("en-") === true || locale?.startsWith("en_") === true;

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

// The walk's own stop at the first token it cannot read, told apart from a fault in the walk itself.
class Malformed extends Error {}

// Every string value with its dotted key path and line. A hand-rolled walk rather than JSON.parse, because the parsed
// object has no line numbers and the caller needs the line to anchor on; malformed input yields what was read before
// the fault, which is enough to anchor anything above it.
export const parseCatalog = (text: string): CatalogEntry[] => {
    const entries: CatalogEntry[] = [];
    let at = 0;
    let line = 1;
    const length = text.length;
    const space = (): void => {
        while (at < length) {
            const char = text[at];
            if (char === "\n") {
                line += 1;
            } else if (char !== " " && char !== "\t" && char !== "\r") {
                return;
            }
            at += 1;
        }
    };
    const string = (): string => {
        // Opening quote already checked by the caller.
        at += 1;
        let out = "";
        let from = at;
        while (at < length) {
            const char = text[at]!;
            if (char === '"') {
                out += text.slice(from, at);
                at += 1;
                return out;
            }
            if (char === "\\") {
                out += text.slice(from, at);
                const escape = text[at + 1] ?? "";
                if (escape === "u") {
                    out += String.fromCharCode(Number.parseInt(text.slice(at + 2, at + 6), 16));
                    at += 6;
                } else {
                    out += ESCAPES[escape] ?? escape;
                    at += 2;
                }
                from = at;
                continue;
            }
            if (char === "\n") {
                line += 1;
            }
            at += 1;
        }
        throw new Malformed("unterminated string");
    };
    const value = (path: readonly string[]): void => {
        space();
        const char = text[at];
        if (char === "{") {
            at += 1;
            space();
            if (text[at] === "}") {
                at += 1;
                return;
            }
            for (;;) {
                space();
                if (text[at] !== '"') {
                    throw new Malformed("expected a key");
                }
                const key = string();
                space();
                if (text[at] !== ":") {
                    throw new Malformed("expected a colon");
                }
                at += 1;
                value([...path, key]);
                space();
                if (text[at] === ",") {
                    at += 1;
                    continue;
                }
                if (text[at] === "}") {
                    at += 1;
                    return;
                }
                throw new Malformed("expected , or }");
            }
        }
        if (char === "[") {
            at += 1;
            space();
            if (text[at] === "]") {
                at += 1;
                return;
            }
            for (let index = 0; ; index += 1) {
                value([...path, String(index)]);
                space();
                if (text[at] === ",") {
                    at += 1;
                    continue;
                }
                if (text[at] === "]") {
                    at += 1;
                    return;
                }
                throw new Malformed("expected , or ]");
            }
        }
        if (char === '"') {
            const startLine = line;
            entries.push({ key: path.join("."), line: startLine, value: string() });
            return;
        }
        // A number, true, false or null: nothing a screenshot shows as text.
        while (at < length && !/[,\]}\s]/.test(text[at]!)) {
            at += 1;
        }
    };
    try {
        value([]);
    } catch (error) {
        // Malformed, or nested deeper than the stack (a RangeError): keep what was read. Anything else is a bug in the walk.
        if (!(error instanceof Malformed) && !(error instanceof RangeError)) {
            throw error;
        }
    }
    return entries;
};

// Parsed catalogs by absolute path, valid while the file's mtime and size hold. The resident engine reads the same
// dozen catalogs on every query; the CLI pays one read per catalog per process either way.
const cache = new Map<string, { readonly mtimeMs: number; readonly size: number; readonly entries: readonly CatalogEntry[] }>();
const CACHE_MAX = 512;

export const loadCatalogs = async (entries: readonly FileEntry[]): Promise<Catalog[]> =>
    (
        await Promise.all(
            entries
                .filter((entry) => isCatalogPath(entry.path))
                .map(async (entry): Promise<Catalog | undefined> => {
                    const cached = cache.get(entry.abs);
                    if (cached !== undefined && cached.mtimeMs === entry.mtimeMs && cached.size === entry.size) {
                        return { path: entry.path, locale: localeOf(entry.path), entries: cached.entries };
                    }
                    // allow(silent-catch): a catalog gone or unreadable since the sweep is skipped, and the others still
                    // answer; failing here would drop the whole literal pass for one file.
                    const text = await readFile(entry.abs, "utf8").catch(() => undefined);
                    if (text === undefined) {
                        return undefined;
                    }
                    const parsed = parseCatalog(text);
                    if (cache.size >= CACHE_MAX) {
                        cache.clear();
                    }
                    cache.set(entry.abs, { mtimeMs: entry.mtimeMs, size: entry.size, entries: parsed });
                    return { path: entry.path, locale: localeOf(entry.path), entries: parsed };
                }),
        )
    ).filter((catalog) => catalog !== undefined);

// ---- matching UI text to an entry ----

// What a screenshot changes and a reader retypes differently: case, whitespace, curly quotes, and punctuation (an
// ellipsis typed as three dots, a colon left out, a closing period). Text is compared as its sequence of words, with
// interpolation slots (`{name}`, `%s`) kept so a template can still be told apart from its filled-in copy.
export const normalizeText = (text: string): string =>
    text
        .toLowerCase()
        .replaceAll(/[‘’ʼ`´]/g, "'")
        .replaceAll(/[^\p{L}\p{N}'{}%\s]+/gu, " ")
        .replaceAll(/(^|\s)'+|'+(?=\s|$)/g, "$1")
        .replaceAll(/\s+/g, " ")
        .trim();

const wordCount = (text: string): number => (text === "" ? 0 : text.split(" ").length);

// Interpolation slots across the common syntaxes: `{name}` (vue-i18n, ICU's simple form), `{{name}}` (i18next),
// `%{name}` (Rails), `%s`/`%d` (printf). A slot matches whatever the screenshot filled it with.
const PLACEHOLDER = /\{\{[^{}]*\}\}|%\{[^{}]*\}|\{[^{}]*\}|%[sd]/g;

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Template {
    // The whole value with every slot as a wildcard, anchored: a filled-in copy matches it.
    readonly filled: RegExp | undefined;
    // The literal runs between slots, normalized: a partial copy of the text contains one of them.
    readonly pieces: readonly string[];
    // Words outside the slots: how much of a filled-in copy the template actually vouches for.
    readonly literalWords: number;
}

// What one slot is filled with: a name, a count, a version, a short phrase. Not a sentence.
const SLOT_FILL = String.raw`\S+(?: \S+){0,3}`;

const templateOf = (value: string): Template => {
    const normalized = normalizeText(value);
    const slots = normalized.match(PLACEHOLDER);
    if (slots === null) {
        return { filled: undefined, pieces: [normalized], literalWords: wordCount(normalized) };
    }
    const pieces = normalized
        .split(PLACEHOLDER)
        .map((piece) => piece.trim())
        .filter((piece) => piece !== "");
    const pattern = normalized
        .split(PLACEHOLDER)
        .map((piece) => escapeRegExp(piece))
        .join(SLOT_FILL);
    return { filled: new RegExp(`^${pattern}$`), pieces, literalWords: pieces.reduce((sum, piece) => sum + wordCount(piece), 0) };
};

// A filled-in template vouches for a query only through its own words: "{count} chat" fits "background job indicator
// in chat", and "{running} · {elapsed}" fits any two words. Its literal words must be at least two and more than half
// the query's: "Checks in {dir}" vouches for "Checks in intentic", not for "Checks in intentic dialog".
const MIN_TEMPLATE_WORDS = 2;
const vouches = (template: Template, queryWords: number): boolean =>
    template.literalWords >= MIN_TEMPLATE_WORDS && template.literalWords * 2 > queryWords;

const templates = new WeakMap<CatalogEntry, readonly Template[]>();

// vue-i18n keeps plural forms in one string, `one | many`; each form is matched on its own.
const templatesOf = (entry: CatalogEntry): readonly Template[] => {
    let cached = templates.get(entry);
    if (cached === undefined) {
        cached = entry.value.split(" | ").map(templateOf);
        templates.set(entry, cached);
    }
    return cached;
};

// The shortest run of text worth matching on its own. Two words ("Archive agent") only count when they are the whole
// string, or a two-word query would match every catalog sentence that happens to contain it.
export const MIN_PARTIAL_WORDS = 3;
// A part of a string counts when it is most of that string or a long run on its own: "how the agent works" inside a
// twenty-word sentence is a coincidence of common words, "no conversation left to send to" is not.
const PARTIAL_COVERAGE = 0.5;
const PARTIAL_LONG_WORDS = 5;
// The share of the query a matched string must account for when the query holds more than the string: a word or two
// around it, not a description that happens to contain a label. Replayed 2026-10-06 against mined queries, 0.6 let a
// nine-word question about automatic persona matching lead with the six-word label of the persona-matching toggle.
const CONTAINED_COVERAGE = 0.75;

export interface MatchOptions {
    // Whole strings only. A query phrased as a question about code is UI text only when it is the entire string
    // ("Are you sure you want to leave?"); a part of a sentence that happens to read like it is not.
    readonly wholeOnly?: boolean;
}

export interface EntryMatch {
    // 1 for the whole string (slots filled in or not), less for a part of it.
    readonly score: number;
    // The query occurs in the string as typed: the whole of it, or a run inside it. A string that only occurs inside a
    // longer query matches, but is not what the query quotes.
    readonly verbatim: boolean;
}

export const entryMatch = (entry: CatalogEntry, normalizedQuery: string, options: MatchOptions = {}): EntryMatch | undefined => {
    const queryWords = wordCount(normalizedQuery);
    let best: EntryMatch | undefined;
    const keep = (candidate: EntryMatch): void => {
        if (best === undefined || candidate.score > best.score) {
            best = candidate;
        }
    };
    for (const template of templatesOf(entry)) {
        const whole =
            template.filled === undefined ? template.pieces[0] === normalizedQuery : vouches(template, queryWords) && template.filled.test(normalizedQuery);
        if (whole) {
            return { score: 1, verbatim: true };
        }
        if (options.wholeOnly === true || queryWords < MIN_PARTIAL_WORDS) {
            continue;
        }
        for (const piece of template.pieces) {
            const pieceWords = wordCount(piece);
            // The screenshot showed part of the string: a sentence of a longer message, a label cut by the layout.
            // Padded so the match falls on word boundaries: "on this account" is not inside "connection this account".
            if (` ${piece} `.includes(` ${normalizedQuery} `)) {
                const coverage = queryWords / Math.max(pieceWords, queryWords);
                if (coverage >= PARTIAL_COVERAGE || queryWords >= PARTIAL_LONG_WORDS) {
                    keep({ score: 0.6 + 0.3 * coverage, verbatim: true });
                }
            } else if (pieceWords >= MIN_PARTIAL_WORDS && ` ${normalizedQuery} `.includes(` ${piece} `)) {
                // The query carries the string plus a word or two around it.
                const coverage = pieceWords / queryWords;
                if (coverage >= CONTAINED_COVERAGE) {
                    keep({ score: 0.5 + 0.3 * coverage, verbatim: false });
                }
            }
        }
    }
    return best;
};

// How well UI text matches one catalog entry: its score, or undefined for no match.
export const matchEntry = (entry: CatalogEntry, normalizedQuery: string, options: MatchOptions = {}): number | undefined =>
    entryMatch(entry, normalizedQuery, options)?.score;

export interface CatalogMatch {
    readonly catalog: Catalog;
    readonly entry: CatalogEntry;
    readonly score: number;
    readonly verbatim: boolean;
}

const lowered = new WeakMap<CatalogEntry, string>();
const lowerOf = (entry: CatalogEntry): string => {
    let lower = lowered.get(entry);
    if (lower === undefined) {
        lower = entry.value.toLowerCase();
        lowered.set(entry, lower);
    }
    return lower;
};

// The query words a matching string must hold at least one of: its longest ones, which a slot is least likely to have
// filled. A substring test per entry, so the template work below runs on a handful of the tens of thousands.
const probeWords = (normalized: string): string[] =>
    [...new Set(normalized.split(" ").filter((word) => word.length >= 3 && !/^[{%]/.test(word)))].toSorted((a, b) => b.length - a.length).slice(0, 3);

// Every entry the text matches, best first and English first among equals. Several matches are normal: the same
// sentence in each locale that has not translated it, or a short label reused under two keys.
export const matchCatalogs = (catalogs: readonly Catalog[], text: string, options: MatchOptions = {}): CatalogMatch[] => {
    const normalized = normalizeText(text);
    const probes = probeWords(normalized);
    if (probes.length === 0) {
        return [];
    }
    const matches: CatalogMatch[] = [];
    for (const catalog of catalogs) {
        for (const entry of catalog.entries) {
            const lower = lowerOf(entry);
            if (!probes.some((probe) => lower.includes(probe))) {
                continue;
            }
            const found = entryMatch(entry, normalized, options);
            if (found !== undefined) {
                matches.push({ catalog, entry, ...found });
            }
        }
    }
    return matches.toSorted(
        (a, b) =>
            b.score - a.score ||
            Number(isEnglish(b.catalog.locale)) - Number(isEnglish(a.catalog.locale)) ||
            (a.catalog.path < b.catalog.path ? -1 : a.catalog.path > b.catalog.path ? 1 : a.entry.line - b.entry.line),
    );
};

// The line a key sits on in a catalog, for the locales that did not match the text but hold the same key: the reader
// changing the copy changes it in each of them.
export const lineOfKey = (catalog: Catalog, key: string): number | undefined => catalog.entries.find((entry) => entry.key === key)?.line;

// A quoted key in code: `t('a.b')`, `$t("a.b")`, `t(\`a.b\`)`, `keypath="a.b"`. The quotes are the whole test, so
// a key named in a comment without quotes does not count as a use.
export const keyUsePattern = (keys: readonly string[]): string => `[\`'"](?:${keys.map(escapeRegExp).join("|")})[\`'"]`;

// The prefix a dynamic key is built from, `t(\`a.b.${kind}\`)`: the fallback when a key has no literal use.
export const dynamicKeyPattern = (key: string): string | undefined => {
    const parent = parentKey(key);
    return parent === undefined ? undefined : `[\`'"]${escapeRegExp(parent)}\\.\\$\\{`;
};

// `a.b` for `a.b.c`; undefined for a top-level key.
export const parentKey = (key: string): string | undefined => {
    const dot = key.lastIndexOf(".");
    return dot <= 0 ? undefined : key.slice(0, dot);
};
