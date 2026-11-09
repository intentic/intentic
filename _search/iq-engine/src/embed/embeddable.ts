import { isCatalogPath } from "../engines/catalog.js";
import { isGenerated } from "../plan/prior.js";

// Whether a file's chunks get a vector. Translation catalogs are answered exactly by the catalog engine, and every
// locale but English is a language this embedder was not trained on. Lockfiles, bundles and snapshots are the
// generated files the class prior already ranks down. Both kinds still get BM25 and literal search. Together they
// were most of the embedding work: one key added near the top of `en.json` re-embedded all five catalogs, 2,425
// chunks, minutes of every core (daemon log, 2026-11-09).
export const embeddable = (path: string): boolean => !isCatalogPath(path) && !isGenerated(path);

// `chunks.embedded` for a chunk deliberately left without a vector. Never 0, so the backlog queries (`embedded = 0`)
// and their partial index pass over it; never 1, so nothing reads it as covered.
export const NOT_EMBEDDED = 2;
