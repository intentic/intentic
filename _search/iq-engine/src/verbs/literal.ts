import {
    type Catalog,
    catalogHome,
    type CatalogEntry,
    type CatalogMatch,
    dynamicKeyPattern,
    isCatalogPath,
    isEnglish,
    keyUsePattern,
    lineOfKey,
    loadCatalogs,
    matchCatalogs,
    normalizeText,
    parentKey,
} from "../engines/catalog.js";
import { type RgOptions, rgSearch } from "../engines/lexical.js";
import { classPrior } from "../plan/prior.js";
import type { EngineHit, FileEntry, RankedGroup, RankedHit } from "../types.js";
import { classOf } from "../workspace/scan.js";

// LITERAL FIRST: a bare query that is a piece of text the workspace holds verbatim is asking where that text is, not
// what it means. Agents open a third of their sessions on a screenshot and search its visible text; the semantic
// pipeline read that text as a question and answered with whatever discussed the same words (2026-10-06: 0 of 6 random
// en.json strings found by a bare query, while `iq find` found each). So a qualifying query is matched literally first,
// and its hits lead, ahead of the semantic results that still follow them.
//
// UI text in an i18n'd app lives in a translation catalog, and the component that renders it holds only the key. The
// second hop resolves a catalog hit to its dotted key and looks the key up in code, so the answer is the component.

export interface LiteralAnswer {
    // Answer groups in rank order: call sites, then the text where it is written, then catalogs.
    readonly groups: RankedGroup[];
    // Each group's tier in that order (call site in source 0, text in source 1, English catalog 2, …): groups of one
    // tier are equally good matches, which the caller may order by other evidence.
    readonly tiers: readonly number[];
    // Capsule lines naming each matched catalog key, where it sits and where code uses it, with the files that line
    // points at, so the caller can list the keys in the order it ranks their files.
    readonly facts: readonly { readonly line: string; readonly paths: readonly string[] }[];
    // One clear match: a single catalog key, or a single file holding the text.
    readonly confident: boolean;
    readonly note: string;
}

type RgBase = Omit<RgOptions, "pattern">;

// Openers of a question about code. Such a query is matched only against whole catalog strings: "where is a widget
// created?" written verbatim in a doc is a doc restating the question, not the answer to it.
const QUESTION_OPENERS = new Set([
    "how",
    "where",
    "what",
    "what's",
    "whats",
    "which",
    "why",
    "who",
    "when",
    "does",
    "do",
    "did",
    "is",
    "are",
    "was",
    "were",
    "can",
    "could",
    "should",
    "would",
    "will",
    "find",
    "show",
    "list",
    "explain",
]);

export const isQuestion = (text: string): boolean => QUESTION_OPENERS.has(normalizeText(text).split(" ")[0] ?? "");

// Copy rather than a description of it: sentence-cased, or closed the way UI text is (a period, an ellipsis, a colon).
// Decides only whether a TWO-word query is tried as a whole catalog string; three words or more always are.
export const looksLikeUiCopy = (text: string): boolean => /^\p{Lu}/u.test(text.trim()) || /(\.|…|:|!)$/.test(text.trim());

// Quoted spans inside a query: the reader marking text as literal. Single quotes only at word edges, so the apostrophe in
// "couldn't" does not open one.
const QUOTED = /"([^"]+)"|“([^”]+)”|`([^`]+)`|(?:^|\s)'([^']+)'(?=[\s.,!?;:]|$)|‘([^’]+)’/g;

export const quotedSpans = (query: string): string[] =>
    [...query.matchAll(QUOTED)].map((match) => (match.slice(1).find((group) => group !== undefined) ?? "").trim()).filter((span) => span !== "");

const stripQuotes = (text: string): string => text.trim().replace(/^["'“‘`]+|["'”’`]+$/g, "");

// Words as written, split on whitespace only: `echo_via_pager` is one name, not three words.
const wordsOf = (text: string): number => text.trim().split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

// Three words or more: shorter runs of prose occur verbatim by coincidence ("error handling").
export const LITERAL_MIN_WORDS = 3;

export interface LiteralCandidate {
    readonly text: string;
    // Whether to search every file for it with rg, beyond the catalogs.
    readonly anywhere: boolean;
    // Whether only whole catalog strings may match it.
    readonly wholeOnly: boolean;
    // Written as copy (quoted, sentence-cased, closed like a sentence) rather than as search words.
    readonly copy: boolean;
}

// What to try literally: the whole query, and each quoted span in it. A question is tried only against whole catalog
// strings; anything else of three words or more is searched for everywhere.
export const literalCandidates = (query: string): LiteralCandidate[] => {
    const whole = stripQuotes(query);
    const spans = quotedSpans(query).filter((span) => span !== whole);
    const candidates: LiteralCandidate[] = [];
    for (const [text, quoted] of [[whole, false], ...spans.map((span) => [span, true] as const)] as const) {
        const words = wordsOf(text);
        const question = !quoted && isQuestion(text);
        const copy = quoted || looksLikeUiCopy(text);
        if (words >= LITERAL_MIN_WORDS) {
            candidates.push({ text, anywhere: !question, wholeOnly: question, copy });
        } else if (words === 2 && copy) {
            candidates.push({ text, anywhere: false, wholeOnly: true, copy });
        }
    }
    return candidates;
};

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The rg pattern for a run of text: its words in order, any whitespace between them, either apostrophe, and without the
// closing punctuation a screenshot ends a sentence on. Case is rg's default here, insensitive.
export const literalPattern = (text: string): string =>
    text
        .trim()
        .replace(/[\s.!?:;,…]+$/u, "")
        .split(/\s+/)
        .filter((word) => word !== "")
        .map((word) => escapeRegExp(word).replaceAll(/['’]/g, "['’]"))
        .join("\\s+");

// Past this many files a phrase is common wording, not a quote: it does not lead, and the semantic answer stands.
const LITERAL_MAX_FILES = 8;
// Keys named in the capsule, and looked up in code; more than this many matches is a short label reused everywhere.
const MAX_KEYS = 3;
// The score below the best a match may fall and still count as another reading of the same text (the same sentence
// under two keys, or in two catalogs); weaker partial matches are left out.
const KEY_SCORE_SLACK = 0.05;

interface KeyMatch {
    readonly key: string;
    // Where the text matched, English first.
    readonly hits: readonly CatalogMatch[];
    readonly score: number;
    // The query occurs in this string as typed (catalog.ts, EntryMatch).
    readonly verbatim: boolean;
}

const inEnglish = (match: KeyMatch): boolean => match.hits.some((hit) => isEnglish(hit.catalog.locale));

const keysOf = (matches: readonly CatalogMatch[]): KeyMatch[] => {
    const best = matches[0]?.score;
    if (best === undefined) {
        return [];
    }
    const byKey = new Map<string, CatalogMatch[]>();
    for (const match of matches) {
        if (match.score < best - KEY_SCORE_SLACK) {
            continue;
        }
        const list = byKey.get(match.entry.key) ?? [];
        list.push(match);
        byKey.set(match.entry.key, list);
    }
    return [...byKey.entries()]
        .map(([key, hits]) => ({ key, hits, score: Math.max(...hits.map((hit) => hit.score)), verbatim: hits.some((hit) => hit.verbatim) }))
        .toSorted((a, b) => b.score - a.score || Number(inEnglish(b)) - Number(inEnglish(a)))
        .slice(0, MAX_KEYS);
};

// Longest shared directory prefix: a key is used by the package whose catalog holds it, so its own call sites rank
// ahead of a same-named key in another package's catalog.
const sharedDepth = (a: string, b: string): number => {
    const left = a.split("/");
    const right = b.split("/");
    let depth = 0;
    while (depth < left.length - 1 && depth < right.length - 1 && left[depth] === right[depth]) {
        depth += 1;
    }
    return depth;
};

const keyInText = (keys: readonly string[], text: string): string | undefined =>
    keys.find((key) => text.includes(`'${key}'`) || text.includes(`"${key}"`) || text.includes(`\`${key}\``));

interface Usage {
    readonly key: string;
    readonly hit: EngineHit;
    // Built from a template prefix rather than written whole.
    readonly dynamic: boolean;
}

// Where code names each key: one rg pass for every key at once (quoted, case-exact), then one more for the keys that
// had none, looking for the template a dynamic key is built from.
const usagesOf = async (keys: readonly KeyMatch[], rgBase: RgBase): Promise<Usage[]> => {
    if (keys.length === 0) {
        return [];
    }
    const names = keys.map((key) => key.key);
    const found = await rgSearch({ ...rgBase, pattern: keyUsePattern(names), caseSensitive: true });
    const usages: Usage[] = [];
    for (const hit of found.hits) {
        const key = isCatalogPath(hit.path) ? undefined : keyInText(names, hit.text);
        if (key !== undefined) {
            usages.push({ key, hit, dynamic: false });
        }
    }
    const unused = names.filter((name) => !usages.some((usage) => usage.key === name));
    const patterns = unused.flatMap((name) => {
        const pattern = dynamicKeyPattern(name);
        return pattern === undefined ? [] : [{ name, pattern }];
    });
    if (patterns.length > 0) {
        const dynamic = await rgSearch({ ...rgBase, pattern: patterns.map((entry) => `(?:${entry.pattern})`).join("|"), caseSensitive: true });
        for (const hit of dynamic.hits) {
            if (isCatalogPath(hit.path)) {
                continue;
            }
            const owner = patterns.find((entry) => hit.text.includes(`${parentKey(entry.name) ?? entry.name}.\${`));
            if (owner !== undefined) {
                usages.push({ key: owner.name, hit, dynamic: true });
            }
        }
    }
    return usages;
};

// A key's uses inside the source tree its catalog serves, when it has any there: the same quoted key in another
// package's test fixture or docs (this one's, quoting an example) is not where the screen is built.
const ownUsages = (keys: readonly KeyMatch[], usages: readonly Usage[]): Usage[] =>
    keys.flatMap((key) => {
        const own = usages.filter((usage) => usage.key === key.key);
        const homes = key.hits.map((hit) => catalogHome(hit.catalog.path));
        const inside = own.filter((usage) => homes.some((home) => usage.hit.path.startsWith(home)));
        return inside.length > 0 ? inside : own;
    });

const grouped = (hits: readonly RankedHit[]): RankedGroup[] => {
    const byPath = new Map<string, RankedHit[]>();
    for (const hit of hits) {
        const list = byPath.get(hit.path) ?? [];
        list.push(hit);
        byPath.set(hit.path, list);
    }
    return [...byPath.entries()].map(([path, list]) => ({ path, score: 0, hits: list.toSorted((a, b) => a.line - b.line) }));
};

const entryHit = (path: string, entry: CatalogEntry): RankedHit => ({
    path,
    line: entry.line,
    text: `"${entry.key.slice(entry.key.lastIndexOf(".") + 1)}": ${JSON.stringify(entry.value)}`,
    tags: [{ kind: "text" }],
    score: 1,
});

const anchor = (hit: { readonly path: string; readonly line: number }): string => `${hit.path}:${hit.line}`;

// One line per matched key: the key, where the matched string sits (and how many other locales hold it), and where code
// uses it. The key is the handle every later step needs: the catalogs to edit, the component to read.
const factOf = (key: KeyMatch, catalogs: readonly Catalog[], usages: readonly Usage[]): string => {
    const lead = key.hits[0]!;
    const locales = catalogs.filter((catalog) => catalog.path !== lead.catalog.path && lineOfKey(catalog, key.key) !== undefined).length;
    const own = usages.filter((usage) => usage.key === key.key);
    const literal = own.filter((usage) => !usage.dynamic);
    const where = `${anchor({ path: lead.catalog.path, line: lead.entry.line })}${locales > 0 ? ` (+${locales} locale${locales === 1 ? "" : "s"})` : ""}`;
    const used =
        literal.length > 0
            ? `used at ${anchor(literal[0]!.hit)}${literal.length > 1 ? ` +${literal.length - 1} more` : ""}`
            : own.length > 0
              ? `built dynamically at ${anchor(own[0]!.hit)}`
              : `no call site names it whole: iq find '${parentKey(key.key) ?? key.key}'`;
    return `key: ${key.key} · ${where} · ${used}`;
};

const catalogLocale = (catalogs: readonly Catalog[], path: string): string | undefined => catalogs.find((catalog) => catalog.path === path)?.locale;

// Classes in the order a reader wants a literal hit: the code that renders the text, then config, tests, docs. The class
// prior already ranks them so for natural-language answers.
const byClass = (groups: readonly RankedGroup[]): RankedGroup[] =>
    groups.toSorted((a, b) => classPrior(b.path) - classPrior(a.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// Matches the query literally: against every translation catalog in scope (whole strings, or long enough parts, slots
// filled in or not), and with rg against every file. Undefined when nothing qualifies or nothing matched, and the
// semantic answer then stands alone.
export const literalAnswer = async (query: string, entries: readonly FileEntry[], rgBase: RgBase): Promise<LiteralAnswer | undefined> => {
    const candidates = literalCandidates(query);
    if (candidates.length === 0) {
        return undefined;
    }
    const rgPatterns = candidates.filter((candidate) => candidate.anywhere).map((candidate) => `(?:${literalPattern(candidate.text)})`);
    const [catalogs, direct] = await Promise.all([
        loadCatalogs(entries),
        rgPatterns.length > 0 ? rgSearch({ ...rgBase, pattern: rgPatterns.join("|") }) : Promise.resolve(undefined),
    ]);
    const matches = candidates
        .flatMap((candidate) => matchCatalogs(catalogs, candidate.text, { wholeOnly: candidate.wholeOnly }))
        .toSorted((a, b) => b.score - a.score || Number(isEnglish(b.catalog.locale)) - Number(isEnglish(a.catalog.locale)));
    const keys = keysOf(matches);
    // A catalog's own lines come from the parse, with their keys; rg's copies of them would only repeat those.
    const directHits = (direct?.hits ?? []).filter((hit) => !isCatalogPath(hit.path));
    const directFiles = new Set(directHits.map((hit) => hit.path));
    // Search words that happen to sit verbatim in a test or a doc (one quoting an earlier query, say) are not where the
    // code is; text in source is, and so is any hit for text written as copy.
    const inSource = [...directFiles].some((path) => classOf(path) === "src");
    const directLeads = directFiles.size > 0 && directFiles.size <= LITERAL_MAX_FILES && (inSource || candidates.some((candidate) => candidate.copy));
    if (keys.length === 0 && !directLeads) {
        return undefined;
    }
    const usages = ownUsages(keys, await usagesOf(keys, rgBase).catch(() => []));
    const homes = keys.flatMap((key) => key.hits.map((hit) => hit.catalog.path));
    const nearest = (path: string): number => Math.max(0, ...homes.map((home) => sharedDepth(home, path)));
    const callGroups = grouped(usages.map((usage) => ({ ...usage.hit, tags: [{ kind: "call" as const }], score: 1 }))).toSorted(
        (a, b) => classPrior(b.path) - classPrior(a.path) || nearest(b.path) - nearest(a.path) || (a.path < b.path ? -1 : 1),
    );
    const directGroups = directLeads ? byClass(grouped(directHits.map((hit) => ({ ...hit, score: 1 })))) : [];
    const catalogHits = keys.flatMap((key) => key.hits.map((hit) => entryHit(hit.catalog.path, hit.entry)));
    const catalogGroups = grouped(catalogHits).toSorted(
        (a, b) => Number(isEnglish(catalogLocale(catalogs, b.path))) - Number(isEnglish(catalogLocale(catalogs, a.path))) || (a.path < b.path ? -1 : 1),
    );
    const isSrc = (group: RankedGroup): boolean => classOf(group.path) === "src";
    const english = (group: RankedGroup): boolean => isEnglish(catalogLocale(catalogs, group.path));
    // The component first, then text written straight into source, then the English catalog line, then the rest.
    const tiered = [
        callGroups.filter(isSrc),
        directGroups.filter(isSrc),
        catalogGroups.filter(english),
        callGroups.filter((group) => !isSrc(group)),
        directGroups.filter((group) => !isSrc(group)),
        catalogGroups.filter((group) => !english(group)),
    ].flatMap((tier, index) => tier.map((group) => ({ group, tier: index })));
    const seen = new Set<string>();
    const kept = tiered.filter(({ group }) => {
        if (seen.has(group.path)) {
            return false;
        }
        seen.add(group.path);
        return true;
    });
    const groups = kept.map(({ group }, rank) => ({ ...group, score: 1 / (rank + 1), hits: group.hits.map((hit) => ({ ...hit, score: 1 / (rank + 1) })) }));
    const srcFiles = directGroups.filter(isSrc).length;
    // One thing the text is: a single key, or a single file that writes it (counting source only when there is source).
    const leaders = keys.length + (srcFiles > 0 ? srcFiles : keys.length === 0 ? directGroups.length : 0);
    return {
        groups,
        tiers: kept.map(({ tier }) => tier),
        facts: keys.map((key) => ({
            line: factOf(key, catalogs, usages),
            paths: [...usages.filter((usage) => usage.key === key.key).map((usage) => usage.hit.path), ...key.hits.map((hit) => hit.catalog.path)],
        })),
        // A catalog string the query only contains (the label plus words around it) is a lead, not a quote.
        confident: leaders === 1 && (keys.length === 0 || keys[0]!.verbatim),
        note: keys.length > 0 ? "UI text: matched a translation catalog literally" : "matched literally",
    };
};

// The second hop for `iq find`: a match that lands in a translation catalog names its key and the code using it, as a
// capsule line. The matches themselves are untouched, since find's answer is where the text is.
export const catalogFacts = async (hits: readonly EngineHit[], entries: readonly FileEntry[], rgBase: RgBase): Promise<string[]> => {
    const paths = new Set(hits.filter((hit) => isCatalogPath(hit.path)).map((hit) => hit.path));
    if (paths.size === 0) {
        return [];
    }
    // Every catalog, not only the matched ones: the capsule counts the other locales holding the same key.
    const catalogs = await loadCatalogs(entries);
    const matches: CatalogMatch[] = [];
    for (const hit of hits) {
        const catalog = catalogs.find((candidate) => candidate.path === hit.path);
        const entry = catalog?.entries.find((candidate) => candidate.line === hit.line);
        if (catalog !== undefined && entry !== undefined) {
            matches.push({ catalog, entry, score: 1, verbatim: true });
        }
    }
    const english = matches.toSorted((a, b) => Number(isEnglish(b.catalog.locale)) - Number(isEnglish(a.catalog.locale)));
    const keys = keysOf(english);
    const usages = ownUsages(keys, await usagesOf(keys, rgBase).catch(() => []));
    return keys.map((key) => factOf(key, catalogs, usages));
};
