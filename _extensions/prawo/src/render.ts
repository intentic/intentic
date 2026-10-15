import { actCitation, type CitationParts, courtName, eliUri, isapUrl, journalAddress, polishDate, rulingCitation, saosUrl } from "./law/citation.js";
import type { SearchHit, SearchResult, Status, Text } from "./law/law.js";
import type { Act } from "./sources/eli.js";
import type { Hit, Judgment } from "./sources/saos.js";
import { htmlLines } from "./text/html.js";
import type { Article, Note, Unit } from "./text/model.js";

/* WHAT `prawo` PRINTS: compact markdown for an agent to read and quote, every answer ending with the line to cite it
   by, and the same facts as JSON for a program (`--json`). Labels are Polish, like the law they describe. */

const IN_FORCE: ReadonlyMap<string, string> = new Map([
    ["IN_FORCE", "obowiązuje"],
    ["NOT_IN_FORCE", "nie obowiązuje"],
    ["UNKNOWN", "status nieustalony"],
]);
const KINDS: ReadonlyMap<SearchHit["kind"], string> = new Map([
    ["act", "akt"],
    ["amendment", "nowelizacja"],
    ["consolidated", "tekst jednolity"],
]);

const inForceLabel = (act: Act): string => IN_FORCE.get(act.inForce ?? "UNKNOWN") ?? act.inForce ?? "status nieustalony";

const staleLine = (stale: string | undefined, savedAt?: string): string[] =>
    stale === undefined ? [] : [`(Z pamięci podręcznej${savedAt === undefined ? "" : ` z ${savedAt.slice(0, 10)}`}: źródło niedostępne — ${stale})`];

// --- search ----------------------------------------------------------------------------------------------------------

export const searchJson = (result: SearchResult) => ({
    total: result.total,
    stemmed: result.stemmed,
    items: result.items.map((hit) => ({ ...hit.act, kind: hit.kind, eli: eliUri(hit.act), citation: journalAddress(hit.act) })),
});

export const searchMarkdown = (result: SearchResult): string => {
    if (result.items.length === 0) {
        return "Brak wyników. Tytuły odmieniają przedmiot („o dowodach osobistych”, „w sprawie instrukcji kancelaryjnej”): spróbuj takiej formy, krótszego fragmentu albo --keyword.";
    }
    const lines = result.items.flatMap((hit) => [
        `- ${hit.act.ELI} · ${hit.act.title}`,
        `  ${[KINDS.get(hit.kind) ?? hit.kind, inForceLabel(hit.act), hit.act.status, journalAddress(hit.act), eliUri(hit.act)].filter(Boolean).join(" · ")}`,
    ]);
    return [
        ...(result.stemmed === undefined ? [] : [`Dokładne słowa nic nie dały; szukano rdzeni: „${result.stemmed}”.`]),
        `${String(result.total)} wyników · pokazano ${String(result.items.length)}: najpierw akty podstawowe, obowiązujące, najnowsze`,
        ...lines,
        ...staleLine(result.stale),
        "Dalej: prawo show <ID> — czy obowiązuje, tekst jednolity, zmiany po nim.",
    ].join("\n");
};

// --- show ------------------------------------------------------------------------------------------------------------

const laterInForce = (status: Status): boolean => status.amendmentsAfter.some((amendment) => !amendment.pending);

// What a text is cited by: the newest consolidated text even when the wording came from the unified one, which has no
// address of its own.
const basisOf = (text: Text): Act => (text.source === "unified" ? (text.status.consolidated ?? text.status.act) : text.edition);

const citationParts = (status: Status, basis: Act): CitationParts => ({
    act: status.act,
    basis,
    laterAmendments: laterInForce(status),
});

const consolidatedLine = (status: Status): string => {
    const text = status.consolidated;
    if (text === undefined && status.consolidatedId !== undefined) {
        return `Ostatni tekst jednolity: ${status.consolidatedId}`;
    }
    if (text === undefined) {
        return "Tekst jednolity: brak — aktualne brzmienie to akt pierwotny z jego zmianami.";
    }
    const asOf = text.legalStatusDate === undefined ? "" : `, stan prawny na ${text.legalStatusDate}`;
    return `Tekst jednolity: ${journalAddress(text)} (${text.ELI}) — obwieszczenie z ${text.announcementDate ?? "?"}${asOf}, ogłoszony ${text.promulgation ?? "?"}`;
};

const SHOWN_AMENDMENTS = 10;

const amendmentLines = (status: Status): string[] => {
    const heading = status.consolidated === undefined ? "Zmiany aktu" : "Zmiany po tekście jednolitym (nieujęte w nim)";
    if (status.amendmentsAfter.length === 0) {
        return [`${heading}: brak w ELI.`];
    }
    if (status.act.inForce === "NOT_IN_FORCE") {
        return [`${heading}: ${String(status.amendmentsAfter.length)} — bez znaczenia dla obecnego stanu prawnego, akt nie obowiązuje.`];
    }
    const hidden = status.amendmentsAfter.length - SHOWN_AMENDMENTS;
    return [
        `${heading}:`,
        ...status.amendmentsAfter.slice(0, SHOWN_AMENDMENTS).map((amendment) => {
            const when = amendment.date === undefined ? "data wejścia w życie nieznana" : `${amendment.pending ? "wejdzie w życie" : "w życiu od"} ${amendment.date}`;
            const title = amendment.act === undefined ? "" : ` — ${amendment.act.title}`;
            return `- ${amendment.id} (${when})${title}`;
        }),
        ...(hidden > 0 ? [`- … i ${String(hidden)} więcej (--json podaje wszystkie)`] : []),
    ];
};

export const statusJson = (status: Status) => ({
    ...status,
    citation: actCitation(citationParts(status, status.consolidated ?? status.act)),
    eli: eliUri(status.act),
    isap: isapUrl(status.act),
});

export const statusMarkdown = (status: Status): string => {
    const act = status.act;
    const by = status.repealedBy.map((entry) => entry.id).join(", ");
    const repeal =
        act.inForce === "NOT_IN_FORCE"
            ? [`Uwaga: akt nie obowiązuje${act.repealDate === undefined ? "" : ` od ${act.repealDate}`}${by === "" ? "" : `; uchylił go ${by} (prawo show ${status.repealedBy[0]?.id ?? ""})`}. Nie cytuj go jako obowiązującego.`]
            : [];
    return [
        `# ${act.title}`,
        `${journalAddress(act)} · ${act.ELI} · ${act.type}`,
        `Status: ${inForceLabel(act)}${act.status === undefined ? "" : ` (${act.status})`}${act.entryIntoForce === undefined ? "" : `; wszedł w życie ${act.entryIntoForce}`}`,
        ...repeal,
        consolidatedLine(status),
        ...amendmentLines(status),
        ...(status.unified === undefined ? [] : [`Tekst ujednolicony Kancelarii Sejmu (bez mocy prawnej, z późniejszymi zmianami): prawo text ${act.ELI} --unified`]),
        ...(status.tribunal.length === 0 ? [] : [`Orzeczenia TK dotyczące aktu: ${status.tribunal.map((entry) => entry.id).join(", ")}`]),
        ...staleLine(status.stale, status.fetchedAt),
        `Linki: ${[eliUri(act), isapUrl(act)].filter(Boolean).join(" · ")}`,
        `Cytat: ${actCitation(citationParts(status, status.consolidated ?? act))}`,
    ].join("\n");
};

// --- text and article --------------------------------------------------------------------------------------------------

const SOURCE_NAMES = { consolidated: "tekst jednolity", original: "tekst pierwotny", unified: "tekst ujednolicony (Kancelaria Sejmu, bez mocy prawnej)" } as const;

const sourceLine = (text: Text): string => {
    const edition = text.edition;
    const what =
        text.source === "consolidated"
            ? `tekst jednolity ${journalAddress(edition)} — obwieszczenie z ${edition.announcementDate ?? "?"}${edition.legalStatusDate === undefined ? "" : `, stan prawny na ${edition.legalStatusDate}`}`
            : text.source === "unified"
              ? `${SOURCE_NAMES.unified}${text.parsed.basis === undefined ? "" : `; ${text.parsed.basis}`}`
              : `${SOURCE_NAMES.original} ${journalAddress(edition)}`;
    return `Źródło: ${what}; ELI ${eliUri(text.status.act)}; plik: ${text.url}`;
};

const statusLine = (status: Status): string => {
    const pending = status.amendmentsAfter.filter((amendment) => amendment.pending);
    const inForce = status.amendmentsAfter.filter((amendment) => !amendment.pending);
    const parts = [`Akt: ${inForceLabel(status.act)}`];
    if (inForce.length > 0) {
        parts.push(`zmiany w życiu po tym tekście: ${inForce.map((amendment) => `${amendment.id} (${amendment.date ?? "?"})`).join(", ")} — sprawdź, czy dotyczą przepisu`);
    }
    if (pending.length > 0) {
        parts.push(`zmiany oczekujące: ${pending.map((amendment) => `${amendment.id} (od ${amendment.date ?? "?"})`).join(", ")}`);
    }
    return [`${parts.join("; ")}.`, ...staleLine(status.stale, status.fetchedAt)].join("\n");
};

const unitLine = (unit: Unit): string => `[${unit.marker}] ${unit.label === "" ? "" : `${unit.label} `}${unit.text}`.trimEnd();

const articleBlock = (article: Article, units: readonly Unit[], notes: readonly Note[]): string[] => [
    `### ${article.marker}`,
    ...units.map(unitLine),
    ...notes.map((note) => `> Przypis${note.marker === article.marker ? "" : ` (${note.marker})`}: ${note.text}`),
];

export const textMarkdown = (text: Text, articles: readonly Article[]): string => {
    const out = [`# ${text.status.act.title}`, sourceLine(text), ...(text.warning === undefined ? [] : [`Uwaga: ${text.warning}`]), ""];
    let heading: string | undefined;
    for (const article of articles) {
        if (article.heading !== undefined && article.heading !== heading) {
            heading = article.heading;
            out.push(`## ${heading}`);
        }
        out.push(...articleBlock(article, article.units, article.notes), "");
    }
    out.push(statusLine(text.status), `Cytat: ${actCitation(citationParts(text.status, basisOf(text)))}`);
    return out.join("\n");
};

// A long text's table of contents: each article with the start of its wording, under its chapter.
export const outlineMarkdown = (text: Text, articles: readonly Article[], length: number): string => {
    const out = [
        `# ${text.status.act.title}`,
        sourceLine(text),
        ...(text.warning === undefined ? [] : [`Uwaga: ${text.warning}`]),
        `Spis: ${String(articles.length)} jednostek, ${String(Math.round(length / 1000))} tys. znaków. Całość: --all (najlepiej do pliku), fragment: --from/--to, przepis: prawo article ${text.status.act.ELI} <nr>.`,
        "",
    ];
    let heading: string | undefined;
    for (const article of articles) {
        if (article.heading !== undefined && article.heading !== heading) {
            heading = article.heading;
            out.push(`## ${heading}`);
        }
        const start = article.units.map((unit) => unit.text).join(" ");
        out.push(`- ${article.marker}: ${start.length > 90 ? `${start.slice(0, 90)}…` : start}`);
    }
    return out.join("\n");
};

export interface Selection {
    readonly article: Article;
    readonly units: readonly Unit[];
    readonly notes: readonly Note[];
    // The marker the selection is cited by: "Art. 35" or "Art. 35 § 1".
    readonly marker: string;
}

export const articleMarkdown = (text: Text, selections: readonly Selection[]): string => {
    const first = selections[0];
    const versions = selections.length > 1 ? ["Ten przepis ma w tekście kilka brzmień: przypisy mówią, które obowiązuje i od kiedy.", ""] : [];
    return [
        `## ${first?.marker ?? ""} · ${text.status.act.title}`,
        ...(first?.article.heading === undefined ? [] : [first.article.heading]),
        ...(text.warning === undefined ? [] : [`Uwaga: ${text.warning}`]),
        "",
        ...versions,
        ...selections.flatMap((selection) => [...articleBlock(selection.article, selection.units, selection.notes).slice(1), ""]),
        `Cytat: ${actCitation(citationParts(text.status, basisOf(text)), first?.marker)}`,
        sourceLine(text),
        statusLine(text.status),
    ].join("\n");
};

export const textJson = (text: Text, selections: readonly Selection[]) => ({
    act: text.status.act,
    source: text.source,
    edition: text.edition,
    format: text.format,
    url: text.url,
    warning: text.warning,
    notice: text.parsed.notice,
    basis: text.parsed.basis,
    amendmentsAfter: text.status.amendmentsAfter,
    articles: selections.map((selection) => ({ ...selection.article, units: selection.units, notes: selection.notes, citation: actCitation(citationParts(text.status, basisOf(text)), selection.marker) })),
    citation: actCitation(citationParts(text.status, basisOf(text)), selections.length === 1 ? selections[0]?.marker : undefined),
    sourceLine: sourceLine(text),
});

// --- rulings -----------------------------------------------------------------------------------------------------------

const COVERAGE =
    "SAOS: sądy powszechne na bieżąco; SN do 2016, TK do 2015, KIO do 2018; bez sądów administracyjnych (NSA i WSA: orzeczenia.nsa.gov.pl). Orzeczenia ilustrują wykładnię, nie wiążą.";

const excerpt = (hit: Hit): string =>
    (hit.textContent ?? "")
        .replaceAll(/<em>([\s\S]*?)<\/em>/giu, "**$1**")
        .replaceAll(/<[^>]*>/gu, " ")
        .replaceAll(/\s+/gu, " ")
        .trim()
        .slice(0, 400);

export const rulingsJson = (hits: { readonly total: number; readonly items: readonly Hit[] }) => ({
    total: hits.total,
    items: hits.items.map((hit) => ({ ...hit, court: courtName(hit), citation: rulingCitation(hit), url: saosUrl(hit.id) })),
    coverage: COVERAGE,
});

export const rulingsMarkdown = (hits: { readonly total: number; readonly items: readonly Hit[] }, stale?: string): string => {
    if (hits.items.length === 0) {
        return ["Brak orzeczeń.", COVERAGE].join("\n");
    }
    return [
        `${String(hits.total)} orzeczeń · pokazano ${String(hits.items.length)}, od najnowszych`,
        ...hits.items.flatMap((hit) => [`- ${rulingCitation(hit)}`, ...(excerpt(hit) === "" ? [] : [`  ${excerpt(hit)}`])]),
        ...staleLine(stale),
        "Dalej: prawo rulings show <id> — treść, podstawa prawna, powołane przepisy.",
        COVERAGE,
    ].join("\n");
};

const SHORT_TEXT = 6000;

export const rulingJson = (judgment: Judgment) => ({
    ...judgment,
    textContent: undefined,
    text: htmlLines(judgment.textContent ?? "").join("\n"),
    court: courtName(judgment),
    citation: rulingCitation(judgment),
});

export const rulingMarkdown = (judgment: Judgment, full: boolean): string => {
    const text = htmlLines(judgment.textContent ?? "").join("\n");
    const shown = full || text.length <= SHORT_TEXT ? text : `${text.slice(0, SHORT_TEXT)}\n… (skrócone: --full pokazuje całość)`;
    const regulations = (judgment.referencedRegulations ?? []).map((regulation) => `- ${regulation.text}`);
    const date = judgment.judgmentDate === undefined || judgment.judgmentDate === null ? "" : ` · ${polishDate(judgment.judgmentDate)}`;
    return [
        `## ${courtName(judgment)}${date}`,
        ...(judgment.summary === undefined || judgment.summary === null || judgment.summary === "" ? [] : [`Teza: ${judgment.summary}`]),
        ...((judgment.legalBases ?? []).length === 0 ? [] : [`Podstawa prawna: ${(judgment.legalBases ?? []).join("; ")}`]),
        ...(regulations.length === 0 ? [] : ["Powołane przepisy:", ...regulations]),
        ...((judgment.keywords ?? []).length === 0 ? [] : [`Hasła: ${(judgment.keywords ?? []).join(", ")}`]),
        "",
        shown,
        "",
        `Cytat: ${rulingCitation(judgment)}`,
        ...(judgment.source?.judgmentUrl === undefined || judgment.source.judgmentUrl === null ? [] : [`Źródło sądu: ${judgment.source.judgmentUrl}`]),
        "Orzeczenie ilustruje wykładnię i nie wiąże w innych sprawach; sprawdź, czy przepisy, które stosuje, nie zmieniły się od jego wydania.",
    ].join("\n");
};
