// Scores blocks against the query with BM25, keeping only ones with signal, in document order; headings are always
// kept. Follows crawl4ai's BM25ContentFilter (Apache-2.0, https://github.com/unclecode/crawl4ai). Plain BM25, k1=1.2
// b=0.75, no stemming.

export interface ScoredBlock<T> {
    readonly block: T;
    readonly score: number;
}

export const tokenize = (text: string): string[] =>
    text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length >= 2)
        .map(foldPlural);

// Folds English plurals (webhooks to webhook, retries to retry) instead of a real stemmer, which would add a dependency
// and a language commitment.
const foldPlural = (token: string): string => {
    if (token.length <= 3) {
        return token;
    }
    if (token.endsWith("ies")) {
        return `${token.slice(0, -3)}y`;
    }
    // -es only marks the plural after a sibilant or o (boxes, patches, heroes); "pages" is page + s.
    if (/(?:[xz]|ch|sh|o)es$/.test(token)) {
        return token.slice(0, -2);
    }
    return token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
};

const K1 = 1.2;
const B = 0.75;

/**
 * Ranks `blocks` against `query`; returns every block with a positive score, highest first. Caller decides how many to
 * keep.
 */
export const bm25Rank = <T>(blocks: readonly T[], textOf: (block: T) => string, query: string): ScoredBlock<T>[] => {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0 || blocks.length === 0) {
        return [];
    }
    const docs = blocks.map((block) => tokenize(textOf(block)));
    const avgLen = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
    const docFrequency = new Map<string, number>();
    for (const term of queryTerms) {
        docFrequency.set(term, docs.filter((doc) => doc.includes(term)).length);
    }
    const scored = blocks.map((block, index) => {
        const doc = docs[index] ?? [];
        const counts = new Map<string, number>();
        for (const token of doc) {
            counts.set(token, (counts.get(token) ?? 0) + 1);
        }
        let score = 0;
        for (const term of queryTerms) {
            const df = docFrequency.get(term) ?? 0;
            if (df === 0) {
                continue;
            }
            const idf = Math.log((docs.length - df + 0.5) / (df + 0.5) + 1);
            const tf = counts.get(term) ?? 0;
            score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.length / avgLen))));
        }
        return { block, score };
    });
    return scored.filter((entry) => entry.score > 0).toSorted((a, b) => b.score - a.score);
};
