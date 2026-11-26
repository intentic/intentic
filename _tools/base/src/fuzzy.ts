// The path scorer both ends of quick-open rank with: the sandbox's file-name search (@intentic/text-search) and the
// app's own search box. One implementation, or the same keystrokes put a different file first depending on which one answered.
//
// A query is whitespace- (or comma-) separated terms, every one of which must match; a path's score is their mean. Each
// term lands in one of two bands on the 0..1 axis the palette orders every kind of row on (commandSearch's tiers):
// - a contiguous hit, 0.75 and up: in the file's own name above in its folders, the name's start above a word's start
//   above mid-word, then the shorter path;
// - a subsequence, at most 0.7: the best alignment of the term's letters, found by dynamic programming in the manner of
//   fzf and VS Code's quick open (consecutive letters and word starts earn, gaps cost), letters in the file's own name
//   earning more than letters in its folders.
// 2026-11-26: replaced a greedy walk that took each letter's first occurrence and matched a space literally; replayed
// through VS Code's own ranking cases (fuzzy.vscode.test.ts) it put the right file first in 16 of 34, this in 32.

// Contiguous hits: the floor, the file's own name, its start (plus how much of the name the term covers), a word start.
const SUBSTRING = 0.75;
const IN_NAME = 0.2;
const NAME_START = 0.03;
const NAME_COVERED = 0.05;
const WORD_START = 0.02;
// Under 0.1, falling as the path grows: the last word between two otherwise equal hits.
const shortness = (length: number): number => 1.6 / (16 + length);

// Subsequences: the ceiling, and the share of it held for an alignment that fits inside the file's own name. A share,
// not a tier: a term whose letters open two words across a folder (`fp`, fuzzy/paths.ts) still beats the same letters
// strewn mid-word through a name (affixups.ts).
const SCATTERED = 0.7;
const NAME_SHARE = 0.25;

// The alignment's arithmetic, fzf's: every letter earns MATCH plus the bonus of where it lands, a run of letters keeps
// the bonus it started on, and a gap costs GAP_START plus GAP_EXTENSION per further letter skipped.
const MATCH = 16;
const GAP_START = 3;
const GAP_EXTENSION = 1;
const AT_START = 10;
const AFTER_SLASH = 9;
const AFTER_PUNCTUATION = 8;
const CAMEL_HUMP = 7;
const CONSECUTIVE = 4;
const FIRST_LETTER = 2;
// A letter an alignment across the folders lands in the file's own name: the name outranks its folders here too.
const IN_NAME_LETTER = 2;

const isUpper = (code: number): boolean => code >= 65 && code <= 90;
// Anything past ASCII counts as a letter, so an accented name is one word and not a run of boundaries.
const isWordCharacter = (code: number): boolean => (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || isUpper(code) || code >= 128;

// What landing on `at` is worth: the path's start, after a slash, after other punctuation, or a camelCase hump (read
// off the original case, `path`, since `haystack` is lowered).
const bonusAt = (haystack: string, path: string, at: number): number => {
    if (at === 0) {
        return AT_START;
    }
    const before = haystack.charCodeAt(at - 1);
    if (before === 47) {
        return AFTER_SLASH;
    }
    if (!isWordCharacter(before)) {
        return AFTER_PUNCTUATION;
    }
    return isUpper(path.charCodeAt(at)) && !isUpper(path.charCodeAt(at - 1)) ? CAMEL_HUMP : 0;
};

// A contiguous hit's score at `at`: in the name or not, at its start (and how much of it the term covers), at a word.
const contiguousScore = (term: string, haystack: string, name: number, at: number, inName: boolean, word: boolean): number => {
    const placed = at === name ? NAME_START + (NAME_COVERED * term.length) / (haystack.length - name) : word ? WORD_START : 0;
    return SUBSTRING + (inName ? IN_NAME : 0) + placed + shortness(haystack.length);
};

// The first occurrence from `from` on that opens a word (the name's start always does), else the first that reaches
// into the name at all when `reaching`, else -1. Occurrences come in order, so the name's start, the earliest place in
// the name, is found first when it is one.
const occurrence = (term: string, haystack: string, path: string, from: number, name: number, reaching: boolean): number => {
    let found = -1;
    for (let at = haystack.indexOf(term, from); at !== -1; at = haystack.indexOf(term, at + 1)) {
        if (reaching && at + term.length <= name) {
            continue;
        }
        if (bonusAt(haystack, path, at) > 0) {
            return at;
        }
        found = reaching && found === -1 ? at : found;
    }
    return found;
};

// A contiguous term's score at its best occurrence: one reaching into the name before one only in the folders, then
// one at the name's start, then at a word's start. Undefined when the term is not a substring at all. The folders are
// searched past the first occurrence only when the name holds none.
const substringScore = (term: string, haystack: string, path: string, name: number): number | undefined => {
    const first = haystack.indexOf(term);
    if (first === -1) {
        return undefined;
    }
    // Most often the first occurrence is already the best: in the name, opening a word.
    if (first + term.length > name && bonusAt(haystack, path, first) > 0) {
        return contiguousScore(term, haystack, name, first, true, true);
    }
    // A term without a slash reaches the name only by starting inside it.
    const inside = occurrence(term, haystack, path, term.includes("/") ? first : Math.max(first, name), name, true);
    const best = inside !== -1 ? inside : Math.max(first, occurrence(term, haystack, path, first, name, false));
    return contiguousScore(term, haystack, name, best, inside !== -1, bonusAt(haystack, path, best) > 0);
};

// Scratch for the alignment, grown to the longest path and term seen, so scoring a candidate allocates nothing: each
// letter's band, and two rows side by side (row i at offset (i % 2) × width): a letter's candidate columns, their
// scores, and the bonus each one's run started on. A row's columns end in a sentinel past any column. Every score is
// a whole number, so integers throughout, with DEAD (far below any alignment, and far from overflowing) standing for
// a candidate no alignment reaches: an infinity there knocks the optimizer off integer arithmetic.
let earliest = new Int32Array(32);
let latest = new Int32Array(32);
let width = 256;
let columns = new Int32Array(width * 2);
let scores = new Int32Array(width * 2);
let runs = new Int32Array(width * 2);
const SENTINEL = 0x7fffffff;
const DEAD = -(1 << 29);

const grow = (length: number, letters: number): void => {
    // Room for every column of a path and the sentinel after them.
    if (width <= length) {
        width = length * 2;
        columns = new Int32Array(width * 2);
        scores = new Int32Array(width * 2);
        runs = new Int32Array(width * 2);
    }
    if (earliest.length < letters) {
        earliest = new Int32Array(letters * 2);
        latest = new Int32Array(letters * 2);
    }
};

// Whether the term's letters appear in order in haystack[from..]: the cheap pass every path pays before any alignment
// is worked out. It writes each letter's earliest place as it goes, every earlier letter taken as early as it goes:
// one edge of the band `latest` closes.
const isSubsequence = (term: string, haystack: string, from: number): boolean => {
    grow(haystack.length, term.length);
    let at = from;
    for (let index = 0; index < term.length; index++) {
        const found = haystack.indexOf(term[index]!, at);
        if (found === -1) {
            return false;
        }
        earliest[index] = found;
        at = found + 1;
    }
    return true;
};

// Each letter's latest place, every later letter taken as late as it goes. Every alignment puts letter i between its
// earliest and its latest, so only the letter's occurrences in that band are candidates. The term is known to be a
// subsequence, so the walk back finds every letter without a bound check.
const bands = (term: string, haystack: string): void => {
    let at = haystack.length;
    for (let index = term.length - 1; index >= 0; index--) {
        const letter = term.charCodeAt(index);
        do {
            at--;
        } while (haystack.charCodeAt(at) !== letter);
        latest[index] = at;
    }
};

// The occurrence of letter `index` after `column` in its band, or -1 past it. Both edges of a band are occurrences of
// its letter, so a row starts on its earliest without searching and the walk stops on its latest at the latest.
const nextIn = (index: number, term: string, haystack: string, column: number): number => {
    if (column >= latest[index]!) {
        return -1;
    }
    const letter = term.charCodeAt(index);
    let at = column + 1;
    while (haystack.charCodeAt(at) !== letter) {
        at++;
    }
    return at;
};

// The first letter's row, at offset 0: each occurrence in its band, worth MATCH and its place's bonus, doubled for
// opening the term. Answers how many there are.
const firstRow = (term: string, haystack: string, path: string, name: number): number => {
    const at = columns;
    const score = scores;
    const run = runs;
    let length = 0;
    for (let column = earliest[0]!; column !== -1; column = nextIn(0, term, haystack, column)) {
        const bonus = bonusAt(haystack, path, column);
        at[length] = column;
        score[length] = MATCH + bonus * FIRST_LETTER + (column >= name ? IN_NAME_LETTER : 0);
        run[length] = bonus;
        length++;
    }
    at[length] = SENTINEL;
    return length;
};

// Letter `index`'s row from the previous one: fzf's affine-gap recurrence over occurrences only. A letter either
// extends the run that ended on the column just before it (keeping that run's starting bonus, or a stronger
// boundary's it crosses) or starts a new run after a gap; since a gap costs the same per letter, the best gapped
// predecessor is the best `score + column × GAP_EXTENSION` two or more columns back. Every load runs on every
// candidate (the sentinel ends the walk), so the optimizer never meets one it has no feedback for.
const nextRow = (index: number, term: string, haystack: string, path: string, name: number): number => {
    const at = columns;
    const score = scores;
    const run = runs;
    const to = (index & 1) * width;
    let written = to;
    let behind = ((index - 1) & 1) * width;
    let reach = DEAD;
    for (let column = earliest[index]!; column !== -1; column = nextIn(index, term, haystack, column)) {
        while (at[behind]! <= column - 2) {
            reach = Math.max(reach, score[behind]! + at[behind]! * GAP_EXTENSION);
            behind++;
        }
        const bonus = bonusAt(haystack, path, column);
        const before = run[behind]!;
        const kept = bonus >= AFTER_PUNCTUATION && bonus > before ? bonus : before;
        const touching = score[behind]! + MATCH + Math.max(bonus, kept, CONSECUTIVE);
        const extended = at[behind] === column - 1 ? touching : DEAD;
        const fresh = reach - GAP_START - (column - 2) * GAP_EXTENSION + MATCH + bonus;
        at[written] = column;
        score[written] = Math.max(extended, fresh) + (column >= name ? IN_NAME_LETTER : 0);
        run[written] = extended >= fresh ? kept : bonus;
        written++;
    }
    at[written] = SENTINEL;
    return written - to;
};

// The best alignment's raw score inside the bands; letters from `name` on earn IN_NAME_LETTER.
const alignment = (term: string, haystack: string, path: string, name: number): number => {
    let length = firstRow(term, haystack, path, name);
    for (let index = 1; index < term.length; index++) {
        length = nextRow(index, term, haystack, path, name);
    }
    const last = ((term.length - 1) & 1) * width;
    let best = DEAD;
    for (let index = last; index < last + length; index++) {
        best = Math.max(best, scores[index]!);
    }
    return best;
};

// A term run from the path's very start, every letter consecutive: the score no alignment can pass.
const perfect = (letters: number): number => MATCH + AT_START * FIRST_LETTER + (letters - 1) * (MATCH + AT_START);

// A scattered term's score, right after isSubsequence found it from the path's start: aligned inside the name when
// its letters all fit there, else across the whole path. They fit exactly when the latest-starting alignment starts
// inside the name.
const subsequenceScore = (term: string, haystack: string, path: string, name: number): number => {
    bands(term, haystack);
    const inName = latest[0]! >= name;
    if (inName && earliest[0]! < name) {
        isSubsequence(term, haystack, name);
    }
    const quality = Math.min(1, Math.max(1, alignment(term, haystack, path, inName ? haystack.length : name)) / perfect(term.length));
    const band = (inName ? NAME_SHARE : 0) + (1 - NAME_SHARE) * quality;
    // At most 5% off for length, so it only separates alignments that are otherwise equal.
    return SCATTERED * band * (0.95 + 0.5 * shortness(haystack.length));
};

/** A query's terms, lowered: split on whitespace and commas, every one of them required. */
const termsOf = (needle: string): readonly string[] => needle.toLowerCase().split(/[\s,]+/u).filter((term) => term.length > 0);

// The mean of every term's score over a path already lowered, NaN the moment one term misses. With `exact` false, a
// scattered term's alignment is left owed and counted at the SCATTERED ceiling, and the answer comes negated: an upper
// bound, settled only for a path that could still make the cut. Numbers only, so scoring a path allocates nothing.
const scored = (terms: readonly string[], haystack: string, path: string, exact: boolean): number => {
    const name = haystack.lastIndexOf("/") + 1;
    let total = 0;
    let owed = false;
    for (const term of terms) {
        if (term.length > haystack.length) {
            return Number.NaN;
        }
        const contiguous = substringScore(term, haystack, path, name);
        if (contiguous !== undefined) {
            total += contiguous;
        } else if (!isSubsequence(term, haystack, 0)) {
            return Number.NaN;
        } else if (exact) {
            total += subsequenceScore(term, haystack, path, name);
        } else {
            total += SCATTERED;
            owed = true;
        }
    }
    return owed ? -total / terms.length : total / terms.length;
};

/**
 * Scores a query against a path, 0..~1, `undefined` when it does not match at all. Every whitespace-separated term must
 * match; a contiguous term beats any scattered one, a hit in the file's own name beats one in its folders, and among
 * scattered ones the compact, word-aligned alignment beats the spread-out one.
 */
export const fuzzyScore = (needle: string, path: string): number | undefined => {
    const terms = termsOf(needle);
    const score = terms.length === 0 ? Number.NaN : scored(terms, path.toLowerCase(), path, true);
    return Number.isNaN(score) ? undefined : score;
};

/** Matching paths, best first, each with its score. */
export type Ranked = { readonly path: string; readonly score: number }[];

// Each path list's lowered copy, for a list ranked again as it stands (quick-open's, once per keystroke): lowering is
// a third of scoring a path. Kept from a list's second ranking on, since a list ranked once (the daemon lists afresh
// for every query) would only pay for the copy. Keyed by the list itself, as fuzzyRanker already is, so a list must
// not be changed in place between rankings; a list of another length is lowered afresh all the same.
const folded = new WeakMap<readonly string[], readonly string[]>();
const seen = new WeakSet<readonly string[]>();

const foldedOf = (paths: readonly string[]): readonly string[] | undefined => {
    const known = folded.get(paths);
    if (known !== undefined && known.length === paths.length) {
        return known;
    }
    if (!seen.has(paths)) {
        seen.add(paths);
        return undefined;
    }
    const lowered = paths.map((path) => path.toLowerCase());
    folded.set(paths, lowered);
    return lowered;
};

// A ranked path, and its place in the list it was ranked from (the next keystroke over that list reads it back).
interface Match {
    readonly path: string;
    readonly score: number;
    readonly id: number;
}

// Best first: the higher score, then the path. Two matches it cannot order are the same path at the same score, so
// which comes first never shows, and a heap and a sort agree on every answer.
const byRank = (a: Match, b: Match): number => b.score - a.score || (a.path < b.path ? -1 : 1);

// The best `limit` of the matches offered, without keeping the rest: a heap whose root is the worst kept, so N matches
// cost N log(limit) rather than a sort of all N, and a match that cannot make the cut is never even allocated.
class Best {
    private readonly heap: Match[] = [];
    private readonly limit: number;

    constructor(limit: number) {
        this.limit = limit;
    }

    // Whether a match at this score and path would be kept.
    wants(score: number, path: string): boolean {
        if (this.heap.length < this.limit) {
            return true;
        }
        const worst = this.heap[0];
        return worst !== undefined && (score > worst.score || (score === worst.score && path < worst.path));
    }

    offer(path: string, score: number, id: number): void {
        if (!this.wants(score, path)) {
            return;
        }
        const match = { path, score, id };
        if (this.heap.length < this.limit) {
            this.heap.push(match);
            this.siftUp(this.heap.length - 1);
        } else {
            this.heap[0] = match;
            this.siftDown(0);
        }
    }

    // Whether a match whose score is at most `bound` could still be kept. The worst kept only rises, so a match turned
    // away here would be turned away at the end too: once `limit` contiguous hits are in, no scattered alignment is
    // worked out at all.
    couldTake(bound: number): boolean {
        const worst = this.heap[0];
        return this.heap.length < this.limit || (worst !== undefined && bound >= worst.score);
    }

    ranked(): Match[] {
        return this.heap.sort(byRank);
    }

    private worse(a: number, b: number): boolean {
        return byRank(this.heap[a]!, this.heap[b]!) > 0;
    }

    private swap(a: number, b: number): void {
        const kept = this.heap[a]!;
        this.heap[a] = this.heap[b]!;
        this.heap[b] = kept;
    }

    private siftUp(from: number): void {
        let child = from;
        while (child > 0 && this.worse(child, (child - 1) >> 1)) {
            this.swap(child, (child - 1) >> 1);
            child = (child - 1) >> 1;
        }
    }

    private siftDown(from: number): void {
        let at = from;
        for (;;) {
            const left = 2 * at + 1;
            let worst = at;
            if (left < this.heap.length && this.worse(left, worst)) {
                worst = left;
            }
            if (left + 1 < this.heap.length && this.worse(left + 1, worst)) {
                worst = left + 1;
            }
            if (worst === at) {
                return;
            }
            this.swap(at, worst);
            at = worst;
        }
    }
}

// One ranking: the best `limit` matches in order, how many matched, and every match's place in the list (in the order
// ranked when unlimited, so the next keystroke's matches arrive nearly sorted and sort cheaply).
interface Pass {
    readonly ranked: Match[];
    readonly matched: number;
    readonly ids: readonly number[];
}

// Ranks the paths it visits. Unlimited, every match is scored exactly and sorted; limited, matches stream into a Best,
// a scattered one's alignment worked out only if its bound could still be kept. `keepIds` records where every match
// sits in the list, for a ranker's next keystroke.
class Scan {
    private readonly terms: readonly string[];
    private readonly lowered: readonly string[] | undefined;
    private readonly exact: boolean;
    private readonly keepIds: boolean;
    private readonly all: Match[] = [];
    private readonly best: Best;
    private readonly ids: number[] = [];
    private matched = 0;

    constructor(terms: readonly string[], lowered: readonly string[] | undefined, limit: number, keepIds: boolean) {
        this.terms = terms;
        this.lowered = lowered;
        this.exact = limit === Infinity;
        this.keepIds = keepIds;
        this.best = new Best(limit);
    }

    visit(path: string, id: number): void {
        const haystack = this.lowered === undefined ? path.toLowerCase() : this.lowered[id]!;
        const score = scored(this.terms, haystack, path, this.exact);
        if (Number.isNaN(score)) {
            return;
        }
        this.matched++;
        if (this.exact) {
            this.all.push({ path, score, id });
            return;
        }
        if (this.keepIds) {
            this.ids.push(id);
        }
        if (score >= 0) {
            this.best.offer(path, score, id);
        } else if (this.best.couldTake(-score)) {
            this.best.offer(path, scored(this.terms, haystack, path, true), id);
        }
    }

    done(): Pass {
        if (this.exact) {
            const ranked = this.all.sort(byRank);
            return { ranked, matched: this.matched, ids: this.keepIds ? ranked.map((match) => match.id) : this.ids };
        }
        return { ranked: this.best.ranked(), matched: this.matched, ids: this.ids };
    }
}

// Every path of a list (or any iterable of paths), ranked.
const scanAll = (terms: readonly string[], paths: Iterable<string>, limit: number, keepIds: boolean): Pass => {
    const scan = new Scan(terms, Array.isArray(paths) ? foldedOf(paths) : undefined, terms.length === 0 ? 0 : limit, keepIds);
    if (terms.length > 0) {
        let id = 0;
        for (const path of paths) {
            scan.visit(path, id++);
        }
    }
    return scan.done();
};

// The paths of a list at `ids` (an earlier answer's), ranked.
const scanSome = (terms: readonly string[], paths: readonly string[], ids: readonly number[], limit: number): Pass => {
    const scan = new Scan(terms, foldedOf(paths), limit, true);
    for (const id of ids) {
        scan.visit(paths[id]!, id);
    }
    return scan.done();
};

// 2026-11-24: replaced sorting every match and slicing, with every path lowered on every call. Best 50 of 500,000
// paths: one letter 275 ms → 49 ms on a list ranked before, 86 ms on one seen for the first time; "sess" 327 → 101 /
// 124 ms; 14,000 real paths, one letter 7.4 → 1.1 ms. The answer is the sort's, element for element, checked against
// the old ranking over 14,000 real and 500,000 paths.
// 2026-11-26: a limited ranking keeps only what could make the cut (no object per match), and works out a scattered
// term's alignment only when its bound could still displace the worst kept.

/**
 * Every matching path, best first. Ties break on the path itself, so the order does not depend on the order the
 * paths arrived in — which is what lets two callers over the same set agree, and a test assert on the answer at all.
 */
export const rankByFuzzy = (needle: string, paths: Iterable<string>): Ranked => topByFuzzy(needle, paths, Infinity).ranked;

/** `rankByFuzzy`'s first `limit` paths, and how many matched in all. */
export interface TopRanked {
    readonly ranked: Ranked;
    readonly matched: number;
}

/** `rankByFuzzy`'s first `limit` paths, and how many matched in all, without ordering the ones past the limit. */
export const topByFuzzy = (needle: string, paths: Iterable<string>, limit: number): TopRanked => {
    const { ranked, matched } = scanAll(termsOf(needle), paths, limit, false);
    return { ranked, matched };
};

/**
 * `rankByFuzzy` for a query typed a key at a time: while the paths are the same collection and the query only grew at
 * its end, only the last answer's paths are scored, since a path that misses a query misses every extension of it (a
 * term that grows matches fewer paths, and a new term is one more that must match).
 * `limit` answers only the best that many, as `topByFuzzy` does; the paths past it are still kept for the next key.
 */
export const fuzzyRanker = (): ((needle: string, paths: readonly string[], limit?: number) => Ranked) => {
    let last: { readonly paths: readonly string[]; readonly needle: string; readonly ids: readonly number[] } | undefined;
    return (needle, paths, limit = Infinity) => {
        const lowered = needle.toLowerCase();
        const terms = termsOf(lowered);
        // A query with no terms yet matched nothing, which says nothing about its extensions.
        const narrowed = last !== undefined && last.paths === paths && termsOf(last.needle).length > 0 && lowered.startsWith(last.needle);
        const pass = narrowed && last !== undefined ? scanSome(terms, paths, last.ids, limit) : scanAll(terms, paths, limit, true);
        last = { paths, needle: lowered, ids: pass.ids };
        return pass.ranked;
    };
};
