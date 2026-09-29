import { open } from "node:fs/promises";
import { sep } from "node:path";
import { mapPool } from "@intentic/base/async";
import { rankByFuzzy } from "@intentic/base/fuzzy";
import { refuse } from "@intentic/contract-serve";
import {
    includeGlobs,
    referenceTails,
    type WorkspaceSearchGroup,
    type WorkspaceSearchHit,
    type WorkspaceSearchResult,
    type WorkspaceSearchSpan,
} from "@intentic/sandbox-contract";
import { cleanRelPath, resolveExisting, segmentsOf } from "./paths.js";
import { type SweptFile, sweep } from "./sweep.js";

// The explorer's search over a folder on the user's disk, answered in the daemon's shape (workspace-search.ts in the
// contract) without its index: every search reads the folder as it is now. `find` matches lines of text, `files`
// matches paths as quick-open does, and any other mode runs as `find`, since a folder has no index of symbols or
// meaning to ask. What one search reads is bounded, and an answer cut by a bound says so rather than reading as all.

// The bounds of one search: files looked at, matching lines kept, and the wall clock, read off `now`. The clock is read
// between files and between lines, so no file holds the search past its budget by more than one line's work.
export interface SearchBounds {
    readonly scanned: number;
    readonly hits: number;
    readonly budgetMs: number;
    readonly now: () => number;
}
export const SEARCH_BOUNDS: SearchBounds = { scanned: 20_000, hits: 2_000, budgetMs: 3_000, now: Date.now };
// A file past this is data, not text anyone searches by hand; one whose first 8 KiB hold a NUL is not text at all.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;
// Lines kept per file, and what one page carries, as the daemon's engine keeps them (iq-engine).
const MAX_PER_FILE = 50;
const PAGE_FILES = 300;
const PAGE_HITS = 1_000;
// A long line is shipped as the part around its first match, spans rebased onto it.
const SNIPPET_MAX = 200;
const SNIPPET_LEAD = 40;
// Files read at once.
const READ_POOL = 8;

export interface SearchQuery {
    readonly query: string;
    readonly mode?: string | undefined;
    readonly includeIgnored?: boolean | undefined;
    readonly dir?: string | undefined;
    readonly literal?: boolean | undefined;
    readonly word?: boolean | undefined;
    readonly caseSensitive?: boolean | undefined;
    readonly include?: string | undefined;
    readonly limit?: number | undefined;
    readonly after?: string | undefined;
}

const NOT_A_PATTERN = `The query isn't a pattern this search reads, so it was searched as plain text.`;
const CUT = `Stopped early: the folder is larger than one search reads. Narrow it to a folder or a file pattern.`;
const TOO_SLOW = `This pattern could take too long to search. Simplify it, or search for the text as typed.`;

// A quantifier at `at`: `*`, `+`, or a count such as `{2}` or `{2,}` (a `?` never repeats, so it cannot compound).
const quantifierAt = (source: string, at: number): boolean =>
    source[at] === `*` || source[at] === `+` || (source[at] === `{` && /^\{\d+(?:,\d*)?\}/.test(source.slice(at)));

// Whether a pattern repeats a group that itself repeats something (`(a+)+`, `(\w*\s?)*`, `(x{2,})+`): the nested
// quantifier whose failure to match backtracks exponentially, so that one line of text can hold the whole process for
// minutes. Read the way the engine reads it: an escape is one character, and nothing inside a class is a quantifier.
export const nestsQuantifiers = (source: string): boolean => {
    // Per group still open, innermost last, whether anything inside it repeats.
    const repeating: boolean[] = [];
    let inClass = false;
    for (let at = 0; at < source.length; at++) {
        const char = source[at];
        if (char === `\\`) {
            at++;
        } else if (inClass) {
            inClass = char !== `]`;
        } else if (char === `[`) {
            inClass = true;
        } else if (char === `(`) {
            repeating.push(false);
        } else if (char === `)`) {
            const repeatsInside = repeating.pop() === true;
            if (repeatsInside && quantifierAt(source, at + 1)) {
                return true;
            }
            if (repeating.length > 0 && (repeatsInside || quantifierAt(source, at + 1))) {
                repeating[repeating.length - 1] = true;
            }
        } else if (repeating.length > 0 && quantifierAt(source, at)) {
            repeating[repeating.length - 1] = true;
        }
    }
    return false;
};

// Only the characters that mean something in a pattern, so an escaped query stays valid with the `u` flag.
const escaped = (text: string): string => text.replaceAll(/[\\^$.*+?()[\]{}|/]/g, `\\$&`);

// A whole word: no letter, digit or underscore on either side, in any script where the pattern allows saying so.
const bounded = (body: string, unicode: boolean): string =>
    unicode ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : `(?<![A-Za-z0-9_])(?:${body})(?![A-Za-z0-9_])`;

interface Matcher {
    readonly regex: RegExp;
    readonly note?: string;
}

const compiled = (source: string, word: boolean, flags: string): RegExp | undefined => {
    for (const unicode of [true, false]) {
        try {
            return new RegExp(word ? bounded(source, unicode) : source, `${flags}${unicode ? `u` : ``}`);
        } catch {
            // allow(silent-catch): a pattern the engine refuses is tried without Unicode mode, then read as plain text.
            continue;
        }
    }
    return undefined;
};

// The query as a pattern, as the search box means it: a pattern unless `literal`, any case unless `caseSensitive`. A
// pattern that could backtrack without end is refused before anything is read, rather than left to hold the process.
export const matcherOf = (search: SearchQuery): Matcher => {
    const flags = search.caseSensitive === true ? `g` : `gi`;
    const word = search.word === true;
    const regex = search.literal === true ? undefined : compiled(search.query, word, flags);
    if (regex !== undefined) {
        return nestsQuantifiers(search.query) ? refuse(TOO_SLOW, 400) : { regex };
    }
    const plain = compiled(escaped(search.query), word, flags) ?? new RegExp(escaped(search.query), flags);
    return search.literal === true ? { regex: plain } : { regex: plain, note: NOT_A_PATTERN };
};

// Whether a root-relative path passes the files-to-include field, in the editor's grammar (search-globs.ts).
const includer = (include: string | undefined): ((path: string) => boolean) => {
    const { globs, notGlobs } = includeGlobs(include);
    const matchers = (patterns: readonly string[]): Bun.Glob[] => patterns.map((pattern) => new Bun.Glob(pattern.replace(/^\.\//, ``)));
    const admit = matchers(globs);
    const exclude = matchers(notGlobs);
    return (path) => (admit.length === 0 || admit.some((glob) => glob.match(path))) && !exclude.some((glob) => glob.match(path));
};

// A file's text, or undefined for one that is not text a person searches: too large, binary, or unreadable.
const textOf = async (abs: string): Promise<string | undefined> => {
    let handle;
    try {
        handle = await open(abs, `r`);
        const found = await handle.stat();
        if (!found.isFile() || found.size > MAX_TEXT_BYTES) {
            return undefined;
        }
        const bytes = await handle.readFile();
        return bytes.subarray(0, SNIFF_BYTES).includes(0) ? undefined : bytes.toString(`utf8`);
    } catch {
        // allow(silent-catch): a file that cannot be read is one there is nothing in to find.
        return undefined;
    } finally {
        await handle?.close();
    }
};

// One matching line as the page carries it: a long line cut around its first match, the spans that survive the cut
// rebased onto it.
const hitOf = (line: number, text: string, spans: readonly WorkspaceSearchSpan[]): WorkspaceSearchHit => {
    const tags: WorkspaceSearchHit[`tags`] = [{ kind: `text` }];
    if (text.length <= SNIPPET_MAX) {
        return { line, text, spans: [...spans], tags };
    }
    const from = Math.max(0, (spans[0]?.start ?? 0) - SNIPPET_LEAD);
    const to = from + SNIPPET_MAX;
    const kept = spans.filter((span) => span.start >= from && span.end <= to).map((span) => ({ start: span.start - from, end: span.end - from }));
    return { line, text: text.slice(from, to), spans: kept, tags };
};

// One file's matching lines as far as they were read, and whether the clock stopped the reading.
interface Matched {
    readonly group: WorkspaceSearchGroup | undefined;
    readonly cut: boolean;
}

// The lines of one file the pattern matches, up to the per-file cap, with every match's character span. The clock is
// read before each line, so a long file stops where the budget runs out rather than where the file does.
const matchedIn = (file: SweptFile, text: string, regex: RegExp, over: () => boolean): Matched => {
    const hits: WorkspaceSearchHit[] = [];
    const groupOf = (capped: boolean): WorkspaceSearchGroup | undefined => {
        if (hits.length === 0) {
            return undefined;
        }
        const group: WorkspaceSearchGroup = { path: file.path, score: hits.length, hits };
        if (capped) {
            group.capped = true;
        }
        return group;
    };
    for (const [index, raw] of text.split(`\n`).entries()) {
        if (over()) {
            return { group: groupOf(false), cut: true };
        }
        const line = raw.endsWith(`\r`) ? raw.slice(0, -1) : raw;
        const matches = [...line.matchAll(regex)];
        if (matches.length === 0) {
            continue;
        }
        if (hits.length === MAX_PER_FILE) {
            return { group: groupOf(true), cut: false };
        }
        const spans = matches.filter((match) => match[0].length > 0).map((match) => ({ start: match.index, end: match.index + match[0].length }));
        hits.push(hitOf(index + 1, line, spans));
    }
    return { group: groupOf(false), cut: false };
};

interface Found {
    readonly groups: readonly WorkspaceSearchGroup[];
    readonly cut: boolean;
}

// Every file's matching lines, read a few at a time until the files, the hit cap or the clock run out.
const findIn = async (files: readonly SweptFile[], regex: RegExp, maxHits: number, over: () => boolean): Promise<Found> => {
    const found: (WorkspaceSearchGroup | undefined)[] = Array.from({ length: files.length });
    let hits = 0;
    let cut = false;
    await mapPool([...files.entries()], READ_POOL, async ([index, file]) => {
        if (cut || hits >= maxHits || over()) {
            cut = true;
            return;
        }
        const text = await textOf(file.abs);
        const matched = text === undefined ? { group: undefined, cut: false } : matchedIn(file, text, regex, over);
        cut ||= matched.cut;
        if (matched.group !== undefined) {
            found[index] = matched.group;
            hits += matched.group.hits.length;
        }
    });
    const groups = found.filter((group) => group !== undefined).toSorted((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
    return { groups, cut };
};

// Paths ranked as quick-open ranks them, the basename's own matches first (@intentic/base/fuzzy).
const filesMatching = (files: readonly SweptFile[], query: string): WorkspaceSearchGroup[] =>
    rankByFuzzy(
        query,
        files.map((file) => file.path),
    ).map(({ path, score }) => {
        const rounded = Math.round(Math.min(1, score) * 100) / 100;
        return { path, score: rounded, hits: [{ line: 1, text: path, spans: [], tags: [{ kind: `fuzzy`, score: rounded }] }] };
    });

// The page `after` asks for: whole groups, up to the page's file and line counts, and where the next page starts.
const pageOf = (groups: readonly WorkspaceSearchGroup[], offset: number, limit: number | undefined) => {
    const files = Math.min(limit ?? PAGE_FILES, PAGE_FILES);
    const page: WorkspaceSearchGroup[] = [];
    let shown = 0;
    for (const group of groups.slice(offset)) {
        if (page.length === files || (page.length > 0 && shown + group.hits.length > PAGE_HITS)) {
            break;
        }
        page.push(group);
        shown += group.hits.length;
    }
    const next = offset + page.length;
    return { page, shown, cursor: next < groups.length ? String(next) : undefined };
};

const offsetOf = (after: string | undefined): number => {
    const offset = Number(after ?? 0);
    return Number.isInteger(offset) && offset >= 0 ? offset : refuse(`invalid cursor`, 400);
};

// The subtree `dir` names, as the daemon reads it: `./` and trailing slashes dropped; undefined for one that leaves.
const dirOf = (dir: string | undefined): readonly string[] | undefined => segmentsOf((dir ?? ``).replace(/^\.\//, ``).replace(/\/+$/, ``));

// Whether a budget that starts now is spent, by the bounds' own clock.
const budget = (bounds: SearchBounds): (() => boolean) => {
    const deadline = bounds.now() + bounds.budgetMs;
    return () => bounds.now() > deadline;
};

export const searchFolder = async (root: string, search: SearchQuery, bounds = SEARCH_BOUNDS): Promise<WorkspaceSearchResult> => {
    const mode = search.mode === `files` ? `files` : `find`;
    const offset = offsetOf(search.after);
    const matcher = mode === `find` ? matcherOf(search) : undefined;
    const over = budget(bounds);
    const dir = dirOf(search.dir);
    const swept =
        dir === undefined
            ? { files: [], cut: false }
            : await sweep(root, { dir, includeIgnored: search.includeIgnored === true, maxFiles: bounds.scanned, over, wanted: includer(search.include) });
    const found =
        matcher === undefined ? { groups: filesMatching(swept.files, search.query), cut: false } : await findIn(swept.files, matcher.regex, bounds.hits, over);
    const cut = swept.cut || found.cut;
    const { page, shown, cursor } = pageOf(found.groups, offset, search.limit);
    const result: WorkspaceSearchResult = {
        mode,
        total: mode === `files` ? found.groups.length : found.groups.reduce((sum, group) => sum + group.hits.length, 0),
        files: found.groups.length,
        shown,
        groups: page,
        freshness: { state: `fresh` },
        truncated: cursor !== undefined || cut,
    };
    if (cut || found.groups.some((group) => group.capped === true)) {
        result.partial = true;
    }
    if (cursor !== undefined) {
        result.cursor = cursor;
    }
    const note = cut ? CUT : matcher?.note;
    if (note !== undefined) {
        result.note = note;
    }
    return result;
};

// Which file a written path means: the path itself when it is there, else the one file whose path ends the same way,
// the longest ending first. A path two files could end in resolves to nothing rather than to a guess, and so does one
// in a folder too large to walk within the bounds: a file found once in the part walked may have a twin past it.
export const resolveIn = async (root: string, reference: string, bounds = SEARCH_BOUNDS): Promise<{ path?: string }> => {
    const tails = referenceTails(reference, root.split(sep).join(`/`));
    const literal = cleanRelPath(tails[0] ?? reference.replaceAll(`\\`, `/`));
    if (literal !== undefined && literal !== `` && (await resolveExisting(root, literal)).kind === `found`) {
        return { path: literal };
    }
    const name = literal?.split(`/`).at(-1);
    if (name === undefined || name === ``) {
        return {};
    }
    const swept = await sweep(root, { dir: [], includeIgnored: false, maxFiles: bounds.scanned, over: budget(bounds), wanted: (path) => path.endsWith(name) });
    if (swept.cut) {
        return {};
    }
    const named = swept.files.map((file) => file.path).filter((path) => path === name || path.endsWith(`/${name}`));
    for (const tail of [...tails, name]) {
        const [only, ...others] = named.filter((path) => path === tail || path.endsWith(`/${tail}`));
        if (only !== undefined) {
            return others.length === 0 ? { path: only } : {};
        }
    }
    return {};
};
