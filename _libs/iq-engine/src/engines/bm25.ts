import type { IndexDb } from "../store/db.js";
import type { EngineHit } from "../types.js";

const TOP_K = 50;

const STOPWORDS = new Set(
    "a an and are as at be but by do does for from has have how i in is it of on or that the this to was we what when where which who why with you".split(
        " ",
    ),
);

// Query text → FTS5 MATCH expression: identifier-friendly terms, stopword-stripped, each double-quoted (so user
// input can never be parsed as MATCH syntax), OR'd — BM25 does the term weighting.
export const toMatch = (query: string): string | undefined => {
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_$][\w$]+/g) ?? [])].filter((term) => !STOPWORDS.has(term));
    if (terms.length === 0) {
        return undefined;
    }
    return terms.map((term) => `"${term.replaceAll('"', "")}"`).join(" OR ");
};

const PRF_DOCS = 10;
const PRF_TERMS = 8;

// RM3-style pseudo-relevance feedback: mine the strongest non-query terms from the first-pass top docs. The
// caller runs the expanded query as a SECOND engine into RRF fusion, so original-query ranks keep their weight.
export const prfTerms = (db: IndexDb, query: string): string[] => {
    const match = toMatch(query);
    if (match === undefined) {
        return [];
    }
    const queryTerms = new Set(match.replaceAll('"', "").toLowerCase().split(" OR "));
    const total = Number(db.get("SELECT COUNT(*) AS n FROM chunks")?.["n"] ?? 0);
    if (total === 0) {
        return [];
    }
    const tf = new Map<string, number>();
    for (const row of db.all(`SELECT text FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`, match, PRF_DOCS)) {
        for (const term of (row["text"] as string).toLowerCase().match(/[a-z_$][\w$]{2,}/g) ?? []) {
            if (!queryTerms.has(term) && !STOPWORDS.has(term)) {
                tf.set(term, (tf.get(term) ?? 0) + 1);
            }
        }
    }
    const scored: { term: string; score: number }[] = [];
    for (const [term, frequency] of tf) {
        const df = Number(db.get("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?", `"${term}"`)?.["n"] ?? 0);
        if (df > 0 && df < total / 4) {
            scored.push({ term, score: frequency * Math.log(total / df) });
        }
    }
    return scored
        .toSorted((a, b) => b.score - a.score || (a.term < b.term ? -1 : 1))
        .slice(0, PRF_TERMS)
        .map(({ term }) => term);
};

// The ranked sparse tier: BM25 over the indexed chunks (rarity-weighted, unlike ripgrep's unranked matching).
// bm25() returns negative "lower is better" scores; displayed normalized to 0..1.
export const bm25Search = (db: IndexDb, query: string, allowed: ReadonlySet<string>): EngineHit[] => {
    const match = toMatch(query);
    if (match === undefined) {
        return [];
    }
    const rows = db.all(
        `SELECT f.path, c.start_line, c.text, bm25(chunks_fts) AS score
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN files f ON f.id = c.file_id
         WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts), f.path, c.start_line LIMIT ?`,
        match,
        TOP_K * 2,
    );
    const hits: EngineHit[] = [];
    for (const row of rows) {
        const path = row["path"] as string;
        if (!allowed.has(path)) {
            continue;
        }
        const text = (row["text"] as string).split("\n")[1]?.trim() ?? (row["text"] as string).split(" § ")[1] ?? "";
        const score = Math.round(Math.min(1, -Number(row["score"]) / 10) * 100) / 100;
        hits.push({ path, line: Number(row["start_line"]), text, tags: [{ kind: "bm25", score }] });
        if (hits.length >= TOP_K) {
            break;
        }
    }
    return hits;
};
