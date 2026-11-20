import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { undefinedIfMissing } from "@intentic/base/errors";
import { z } from "zod";
import type { RecentVisit, SeedPage, SeedTerm } from "./browsing-index.js";

// What Chromium itself recorded in a persistent profile (`<profile>/Default/History`), read once to seed that profile's
// index (browsing-store.ts): the person's own window kept a history before this index existed, and keeps one in parallel.
//
// Never opened in place. Chromium holds the database open while it runs, and keeps it in WAL mode, so its newest writes
// sit in `History-wal` beside it until a checkpoint: the file and its log are copied to a scratch directory together,
// the copy is opened (which replays the log into it), and the scratch is removed. Nothing is ever written to the
// profile.

// Chromium's clock: microseconds since 1601-01-01. Divided in SQL, since the raw value is past a double's exact range.
const EPOCH_DELTA_MS = 11_644_473_600_000;
const MS = `/ 1000 - ${EPOCH_DELTA_MS}`;

// The low byte of a visit's transition is its core type (ui::PageTransition).
const TYPED = 1;
const AUTO_SUBFRAME = 3;
const MANUAL_SUBFRAME = 4;
const GENERATED = 5;
const RELOAD = 8;
const KEYWORD = 9;
const KEYWORD_GENERATED = 10;
// Qualifier on a visit that redirected onward: the page passed through, not one the person stopped at.
const CHAIN_END = 0x20000000;
const REDIRECT = 0xc0000000;

const RECENT_PER_PAGE = 10;
// How many pages and visits to take in at most: the index keeps fewer than this anyway.
const PAGE_LIMIT = 20_000;
const VISIT_LIMIT = 200_000;
const TERM_LIMIT = 1000;

export interface ChromiumHistory {
    readonly pages: readonly SeedPage[];
    readonly terms: readonly SeedTerm[];
}

// Rows as this module's queries name their columns, parsed rather than trusted: the file is Chromium's, of whatever
// version wrote it, and a row this build cannot read is skipped rather than taken for something it is not.
const UrlRowSchema = z.object({
    id: z.number(),
    url: z.string(),
    title: z.string().nullable(),
    visits: z.number(),
    typed: z.number(),
    last: z.number(),
});
const VisitRowSchema = z.object({ page: z.number(), at: z.number(), transition: z.number() });
const TermRowSchema = z.object({ term: z.string(), last: z.number() });

const rowsOf = <T>(schema: z.ZodType<T>, rows: readonly unknown[]): T[] =>
    rows.flatMap((row) => {
        const parsed = schema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
    });

// Whether a visit stands for somewhere the person went: not a reload, a frame inside a page, or a hop a redirect
// passed through on its way.
const counted = (transition: number): boolean => {
    const core = transition & 0xff;
    if (core === RELOAD || core === AUTO_SUBFRAME || core === MANUAL_SUBFRAME) {
        return false;
    }
    const passedThrough = (transition & REDIRECT) === 0 ? false : (transition & CHAIN_END) === 0;
    return !passedThrough;
};

const typedCore = (transition: number): boolean => {
    const core = transition & 0xff;
    return core === TYPED || core === GENERATED || core === KEYWORD || core === KEYWORD_GENERATED;
};

const readCopy = (path: string): ChromiumHistory => {
    const db = new DatabaseSync(path);
    try {
        const urls = rowsOf(
            UrlRowSchema,
            db
                .prepare(
                    `SELECT id, url, title, visit_count AS visits, typed_count AS typed, last_visit_time ${MS} AS last
                     FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ?`,
                )
                .all(PAGE_LIMIT),
        );
        const visits = rowsOf(
            VisitRowSchema,
            db.prepare(`SELECT url AS page, visit_time ${MS} AS at, transition FROM visits ORDER BY visit_time DESC LIMIT ?`).all(VISIT_LIMIT),
        );
        const recent = new Map<number, RecentVisit[]>();
        for (const visit of visits) {
            const list = recent.get(visit.page) ?? [];
            if (list.length < RECENT_PER_PAGE && counted(visit.transition)) {
                list.push(typedCore(visit.transition) ? { at: visit.at, typed: true } : { at: visit.at });
                recent.set(visit.page, list);
            }
        }
        const pages = urls.map(
            (row): SeedPage => ({
                url: row.url,
                title: row.title === null || row.title === "" ? undefined : row.title,
                visits: row.visits,
                typed: row.typed,
                last: Math.max(0, row.last),
                recent: recent.get(row.id) ?? [],
            }),
        );
        const terms = rowsOf(
            TermRowSchema,
            db
                .prepare(
                    `SELECT k.term AS term, MAX(u.last_visit_time) ${MS} AS last
                     FROM keyword_search_terms k JOIN urls u ON u.id = k.url_id
                     GROUP BY k.term ORDER BY last DESC LIMIT ?`,
                )
                .all(TERM_LIMIT),
        );
        return { pages, terms: terms.map((row) => ({ term: row.term, last: Math.max(0, row.last) })) };
    } finally {
        db.close();
    }
};

/**
 * Chromium's history of the profile at `profileDir`, read from a copy; undefined when the profile has none (never
 * browsed, or not a persistent profile at all).
 */
export const readChromiumHistory = async (profileDir: string, scratch: string = tmpdir()): Promise<ChromiumHistory | undefined> => {
    const source = join(profileDir, "Default", "History");
    const dir = await mkdtemp(join(scratch, "intentic-history-"));
    try {
        const copy = join(dir, "History");
        const copied = await copyFile(source, copy)
            .then(() => true)
            .catch(undefinedIfMissing);
        if (copied === undefined) {
            return undefined;
        }
        // The log and its rollback twin travel with the file, or the copy is missing whatever Chromium wrote last.
        for (const suffix of ["-wal", "-journal"]) {
            await copyFile(`${source}${suffix}`, `${copy}${suffix}`).catch(undefinedIfMissing);
        }
        return readCopy(copy);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};
