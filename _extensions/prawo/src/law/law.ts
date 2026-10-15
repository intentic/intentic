import { createHash } from "node:crypto";
import { z } from "zod";
import type { Cache, Cached } from "../cache.js";
import { type Act, ActSchema, actId, ELI_API, type Eli, type Reference, type SearchPage, SearchPageSchema, type SearchQuery } from "../sources/eli.js";
import { HitSchema, type Hits, type Judgment, JudgmentSchema, type RulingQuery, type Saos } from "../sources/saos.js";
import { articlesFromHtml } from "../text/html.js";
import type { ParsedText } from "../text/model.js";
import { articlesFromPdfText } from "../text/pdf.js";

/* WHAT AN AGENT ASKS OF THE LAW, ANSWERED FROM THE SOURCES THROUGH THE CACHE: which acts match, whether one is in
   force and which text of it is current, that text as articles, and rulings. The judgement calls live here, once:
   which text is current (the newest consolidated text, else the act's own when nothing amended it, else the
   Chancellery's unofficial unified text), and which amendments that text does not yet contain. */

const HOUR = 60 * 60 * 1000;
const METADATA_AGE = 12 * HOUR;
const SEARCH_AGE = HOUR;
// Raised whenever the readers change what they make of a text, so a copy parsed by an older reader is read again.
const READER_VERSION = 5;

export type SourceKind = "consolidated" | "original" | "unified";

export interface Amendment {
    readonly id: string;
    // When the change takes effect for this act.
    readonly date?: string | undefined;
    // Not yet in force on the day asked.
    readonly pending: boolean;
    readonly act?: Act | undefined;
}

export interface Status {
    readonly act: Act;
    // The newest consolidated text ("tekst jednolity"), when the act has one; for a repealed act only its address
    // (`consolidatedId`), unless its text is asked for.
    readonly consolidated?: Act | undefined;
    readonly consolidatedId?: string | undefined;
    // Amendments that take effect after the consolidated text's legal status date: its wording does not show them. All
    // of the act's amendments when it has no consolidated text.
    readonly amendmentsAfter: readonly Amendment[];
    readonly repealedBy: readonly Reference[];
    readonly tribunal: readonly Reference[];
    // The Chancellery's unified text, current between consolidations but without legal force.
    readonly unified?: { readonly type: string; readonly fileName: string } | undefined;
    readonly fetchedAt: string;
    readonly stale?: string | undefined;
}

export interface Text {
    readonly status: Status;
    readonly source: SourceKind;
    // The act whose text this is: the consolidated text's announcement, or the act itself.
    readonly edition: Act;
    readonly format: "html" | "pdf";
    readonly url: string;
    readonly parsed: ParsedText;
    readonly warning?: string | undefined;
}

export interface SearchHit {
    readonly act: Act;
    readonly kind: "act" | "amendment" | "consolidated";
}

const UnitSchema = z.object({ marker: z.string(), label: z.string(), text: z.string() });
const ParsedTextSchema = z.object({
    articles: z.array(
        z.object({
            number: z.string(),
            marker: z.string(),
            heading: z.string().optional(),
            units: z.array(UnitSchema),
            notes: z.array(z.object({ marker: z.string(), text: z.string() })),
        }),
    ),
    notice: z.string().optional(),
    basis: z.string().optional(),
});
const StoredTextSchema = z.object({ format: z.enum(["html", "pdf"]), url: z.string(), parsed: ParsedTextSchema });
const HitsSchema = z.object({ items: z.array(HitSchema), total: z.number() });

export interface LawDeps {
    readonly eli: Eli;
    readonly saos: Saos;
    readonly cache: Cache;
    // The PDF's text layer as `fileq read --plain` prints it.
    readonly pdfText: (bytes: Uint8Array) => Promise<string>;
    readonly today: () => string;
    readonly refresh?: boolean | undefined;
}

const AMENDING = /\bo zmianie\b|\bzmieniając[aey]\b/iu;
const kindOf = (act: Act): SearchHit["kind"] => {
    if (act.type === "Obwieszczenie" && /jednolitego tekstu/iu.test(act.title)) {
        return "consolidated";
    }
    return AMENDING.test(act.title) ? "amendment" : "act";
};

// The act's subject as its title states it after the date, for telling "o dowodach osobistych" from "o zmianie ustawy
// o dowodach osobistych".
const subjectOf = (title: string): string =>
    title
        .replace(/^.*?\d{4}\s*r\.\s*(?:[–-]\s*)?/u, "")
        .replace(/\.$/u, "")
        .toLowerCase();

// Best first: the act itself over its amendments and consolidated texts, its exact title, in force, newest.
const rank = (query: string, hits: readonly SearchHit[]): SearchHit[] => {
    const wanted = query.trim().toLowerCase();
    const score = (hit: SearchHit): number =>
        (hit.kind === "act" ? 0 : 4) + (wanted !== "" && subjectOf(hit.act.title) === wanted ? 0 : 2) + (hit.act.inForce === "IN_FORCE" ? 0 : 1);
    return hits.toSorted((a, b) => score(a) - score(b) || b.act.year - a.act.year || b.act.pos - a.act.pos);
};

const byNewest = (a: Reference, b: Reference): number => b.id.localeCompare(a.id, "en", { numeric: true });

// The title search matches word beginnings without inflecting them, and titles put their subject in the genitive or
// locative ("w sprawie instrukcji kancelaryjnej"). A word's stem matches every case: "instrukcja" → "instruk".
const stems = (title: string): string =>
    title
        .split(/\s+/u)
        .map((word) => (word.length > 5 ? word.slice(0, -3) : word))
        .join(" ");

export interface SearchResult {
    readonly total: number;
    readonly items: SearchHit[];
    // The stems searched for instead, when the words as given matched nothing.
    readonly stemmed?: string | undefined;
    readonly stale?: string | undefined;
}

export interface ActQuery extends SearchQuery {
    readonly repealed?: boolean | undefined;
}

export class Law {
    constructor(private readonly deps: LawDeps) {}

    async search(query: ActQuery): Promise<SearchResult> {
        const found = await this.searchAs(query);
        const title = query.title ?? "";
        if (found.total > 0 || stems(title) === title) {
            return found;
        }
        return { ...(await this.searchAs({ ...query, title: stems(title) })), stemmed: stems(title) };
    }

    private async searchAs(query: ActQuery): Promise<SearchResult> {
        // The API sorts by publisher and position, not relevance, so the page is taken whole and ranked here.
        const pages: SearchPage[] = [];
        let stale: string | undefined;
        for (let offset = 0; offset < 500; offset += 100) {
            const page = await this.cachedSearch({ ...query, limit: 100, offset });
            stale ??= page.stale;
            pages.push(page.value);
            const seen = pages.reduce((count, entry) => count + entry.items.length, 0);
            const repealed = pages.flatMap((entry) => entry.items).filter((act) => act.inForce === "NOT_IN_FORCE").length;
            if (query.repealed !== true || repealed >= query.limit || seen >= page.value.totalCount || page.value.items.length === 0) {
                break;
            }
        }
        const items = pages
            .flatMap((page) => page.items)
            .filter((act) => query.repealed !== true || act.inForce === "NOT_IN_FORCE")
            .map((act): SearchHit => ({ act, kind: kindOf(act) }));
        const total = query.repealed === true ? items.length : (pages[0]?.totalCount ?? 0);
        return { total, items: rank(query.title ?? "", items).slice(0, query.limit), stale };
    }

    // `forText`: the consolidated text is needed even for a repealed act, whose current status needs only the facts.
    async status(raw: string, forText = false): Promise<Status> {
        const id = actId(raw);
        const cached = await this.act(id);
        const act = cached.value;
        const repealed = act.inForce === "NOT_IN_FORCE";
        const latest = (act.references?.["Inf. o tekście jednolitym"] ?? []).toSorted(byNewest)[0];
        const consolidated = latest === undefined || (repealed && !forText) ? undefined : (await this.act(latest.id)).value;
        const cutoff = consolidated?.legalStatusDate ?? consolidated?.announcementDate;
        const today = this.deps.today();
        const after = (act.references?.["Akty zmieniające"] ?? [])
            .filter((reference) => cutoff === undefined || reference.date === undefined || reference.date > cutoff)
            .toSorted((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
        // The amending acts' own titles, fetched for the few a reader needs to look at.
        const amendmentsAfter = await Promise.all(
            after.map(async (reference, index): Promise<Amendment> => ({
                id: reference.id,
                date: reference.date,
                pending: reference.date !== undefined && reference.date > today,
                act: index < 8 && !repealed ? await this.titleOf(reference.id) : undefined,
            })),
        );
        const unified = act.texts?.find((file) => file.type === "U");
        return {
            act,
            consolidated,
            consolidatedId: latest?.id,
            amendmentsAfter,
            repealedBy: [...(act.references?.["Akty uchylające"] ?? []), ...(act.references?.["Uchylenia wynikające z"] ?? [])],
            tribunal: act.references?.["Orzeczenie TK"] ?? [],
            unified,
            fetchedAt: cached.savedAt,
            stale: cached.stale,
        };
    }

    // The act's current text: `prefer` picks the act's own text or the unified one over the default choice.
    async text(raw: string, prefer?: "original" | "unified"): Promise<Text> {
        const status = await this.status(raw, true);
        const inForceAmendments = status.amendmentsAfter.some((amendment) => !amendment.pending);
        const source: SourceKind =
            prefer ?? (status.consolidated !== undefined ? "consolidated" : inForceAmendments && status.unified !== undefined ? "unified" : "original");
        const edition = source === "consolidated" && status.consolidated !== undefined ? status.consolidated : status.act;
        if (source === "unified" && status.unified === undefined) {
            throw new Error(`${status.act.ELI} has no unified text (tekst ujednolicony) in the Sejm's database`);
        }
        const key = `texts/${source}/${edition.ELI}/v${String(READER_VERSION)}${source === "unified" ? `/${status.act.changeDate ?? ""}` : ""}`;
        const stored = await this.deps.cache.through(key, StoredTextSchema, async () => await this.fetchText(edition, source, status));
        const warning =
            source === "unified"
                ? "Tekst ujednolicony Kancelarii Sejmu: aktualny, ale bez mocy prawnej; cytuj tekst jednolity i zmiany."
                : source === "original" && (status.consolidated !== undefined || status.amendmentsAfter.length > 0)
                  ? "To pierwotne brzmienie aktu, bez późniejszych zmian: nie cytuj go jako obowiązującego."
                  : undefined;
        return { status, source, edition, ...stored.value, warning };
    }

    async rulings(query: RulingQuery): Promise<Cached<Hits>> {
        const url = JSON.stringify(query);
        const key = `rulings-search/${createHash("sha1").update(url).digest("hex")}`;
        return await this.deps.cache.through(key, HitsSchema, async () => await this.deps.saos.search(query), { maxAgeMs: SEARCH_AGE, refresh: this.deps.refresh });
    }

    async ruling(id: number): Promise<Cached<Judgment>> {
        return await this.deps.cache.through(`rulings/${String(id)}`, JudgmentSchema, async () => await this.deps.saos.judgment(id), {
            maxAgeMs: 30 * 24 * HOUR,
            refresh: this.deps.refresh,
        });
    }

    // An amending act's record, for its title beside the reference.
    private async titleOf(id: string): Promise<Act | undefined> {
        try {
            return (await this.act(id)).value;
        } catch {
            // allow(silent-catch): the title only labels the reference printed beside it; offline and never fetched, the reference is still the answer
            return undefined;
        }
    }

    private async act(id: string): Promise<Cached<Act>> {
        return await this.deps.cache.through(`acts/${id}`, ActSchema, async () => await this.deps.eli.act(id), { maxAgeMs: METADATA_AGE, refresh: this.deps.refresh });
    }

    private async cachedSearch(query: SearchQuery): Promise<Cached<SearchPage>> {
        const key = `search/${createHash("sha1").update(JSON.stringify(query)).digest("hex")}`;
        return await this.deps.cache.through(key, SearchPageSchema, async () => await this.deps.eli.search(query), { maxAgeMs: SEARCH_AGE, refresh: this.deps.refresh });
    }

    private async fetchText(edition: Act, source: SourceKind, status: Status): Promise<z.infer<typeof StoredTextSchema>> {
        const base = `${ELI_API}/acts/${edition.ELI}`;
        if (source === "unified" && status.unified !== undefined) {
            const text = await this.deps.pdfText(await this.deps.eli.pdf(edition.ELI, status.unified));
            return { format: "pdf", url: `${base}/text/U/${status.unified.fileName}`, parsed: this.articles(articlesFromPdfText(text, { unified: true }), base) };
        }
        const html = edition.textHTML === true ? await this.deps.eli.html(edition.ELI) : undefined;
        const fromHtml = html === undefined ? undefined : articlesFromHtml(html);
        if (fromHtml !== undefined && fromHtml.articles.length > 0) {
            return { format: "html", url: `${base}/text.html`, parsed: fromHtml };
        }
        const text = await this.deps.pdfText(await this.deps.eli.pdf(edition.ELI));
        return { format: "pdf", url: `${base}/text.pdf`, parsed: this.articles(articlesFromPdfText(text), base) };
    }

    private articles(parsed: ParsedText, url: string): ParsedText {
        if (parsed.articles.length === 0) {
            throw new Error(`no articles could be read from ${url}: open it with \`fileq read\` and quote it by hand`);
        }
        return parsed;
    }
}
