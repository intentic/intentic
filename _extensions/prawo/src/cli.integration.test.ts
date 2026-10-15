import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "./cache.js";
import { execute, type Output } from "./cli.js";
import { Law } from "./law/law.js";
import { ActSchema, Eli } from "./sources/eli.js";
import { createHttp } from "./sources/http.js";
import { Saos } from "./sources/saos.js";

// The whole CLI against recorded answers of the Sejm's ELI API and SAOS (src/fixtures, trimmed), with no network: each
// request is routed to its fixture and recorded, a PDF comes back as what `fileq` printed for it, and the cache is a
// temp dir.
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const TODAY = "2026-10-13";

const amendment = {
    ELI: "DU/2026/1206",
    publisher: "DU",
    year: 2026,
    pos: 1206,
    type: "Ustawa",
    displayAddress: "Dz.U. 2026 poz. 1206",
    title: "Ustawa z dnia 31 lipca 2026 r. o zmianie ustawy - Prawo bankowe oraz niektórych innych ustaw",
};

const ROUTES: readonly (readonly [RegExp, string])[] = [
    [/\/eli\/acts\/search\?/u, "eli-search-dowody.json"],
    [/\/eli\/acts\/DU\/1960\/168$/u, "eli-act-kpa.json"],
    [/\/eli\/acts\/DU\/2025\/1691$/u, "eli-tj-kpa-2025.json"],
    [/\/eli\/acts\/DU\/2024\/572$/u, "eli-tj-kpa-2024.json"],
    [/\/eli\/acts\/DU\/2024\/572\/text\.html$/u, "kpa-tj-2024.html"],
    [/\/eli\/acts\/DU\/2010\/1131$/u, "eli-act-dowody.json"],
    [/\/eli\/acts\/DU\/2025\/1753$/u, "eli-tj-dowody-2025.json"],
    [/\/eli\/acts\/DU\/1974\/85$/u, "eli-act-dowody-1974.json"],
    [/\/eli\/acts\/DU\/2011\/67$/u, "eli-act-instrukcja.json"],
    [/\/api\/search\/judgments\?/u, "saos-search.json"],
    [/\/api\/judgments\/552277$/u, "saos-judgment.json"],
];

// What `fileq read --plain` printed for each PDF.
const PDF_TEXT: ReadonlyMap<string, string> = new Map([
    ["DU/2025/1691/text.pdf", "kpa-tj-2025.pdf.md"],
    ["DU/2025/1753/text.pdf", "dowody-tj-2025.pdf.md"],
    ["DU/2010/1131/text/U/D20101131Lj.pdf", "dowody-unified.pdf.md"],
    ["DU/2011/67/text.pdf", "instrukcja-2011.pdf.md"],
]);

const bodyFor = (url: string): string | undefined => {
    if (url.endsWith("/DU/2026/1206")) {
        return JSON.stringify(amendment);
    }
    const pdf = /\/eli\/acts\/(.+\.pdf)$/u.exec(url)?.[1];
    if (pdf !== undefined) {
        // The bytes stand for the file; pdfText below maps them back to its text.
        return PDF_TEXT.has(pdf) ? `%PDF ${pdf}` : undefined;
    }
    const route = ROUTES.find(([pattern]) => pattern.test(url));
    return route === undefined ? undefined : fixture(route[1]);
};

interface Harness {
    readonly run: (...argv: string[]) => Promise<Output>;
    readonly urls: string[];
}

interface Options {
    // Answer instead of the recorded routes: a string, or a thrown error for a network that is down.
    readonly override?: (url: string) => string | undefined;
}

const harness = (dir: string, options: Options = {}): Harness => {
    const urls: string[] = [];
    // SAFETY: the clients call fetch with a URL string and an init object only, which this function answers.
    const fetcher = (async (input: string | URL | Request): Promise<Response> => {
        const url = String(input instanceof Request ? input.url : input);
        urls.push(url);
        const body = options.override?.(url) ?? bodyFor(url);
        return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 });
    }) as typeof fetch;
    const pdfText = async (bytes: Uint8Array): Promise<string> => {
        const name = PDF_TEXT.get(new TextDecoder().decode(bytes).replace(/^%PDF /u, ""));
        if (name === undefined) {
            throw new Error("not a recorded PDF");
        }
        return fixture(name);
    };
    const http = createHttp(fetcher);
    const law = new Law({ eli: new Eli(http), saos: new Saos(http), cache: new Cache(dir, () => new Date(`${TODAY}T12:00:00Z`)), pdfText, today: () => TODAY });
    return { run: async (...argv) => await execute(argv, law, { limit: 10, today: TODAY }), urls };
};

const offline = (): string => {
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.sejm.gov.pl");
};

let root: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "prawo-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

test("search asks ELI for a whole page and puts the act itself before its amendments", async () => {
    const { run, urls } = harness(root);
    const result = await run("search", "o dowodach osobistych", "--type", "Ustawa", "--in-force", "--limit", "2");
    expect(result.code).toBe(0);
    expect(Object.fromEntries(new URL(urls[0] ?? "").searchParams)).toEqual({ title: "o dowodach osobistych", type: "Ustawa", inForce: "1", limit: "100", offset: "0" });
    expect(result.text.split("\n").slice(0, 3)).toEqual([
        "21 wyników · pokazano 2: najpierw akty podstawowe, obowiązujące, najnowsze",
        "- DU/2010/1131 · Ustawa z dnia 6 sierpnia 2010 r. o dowodach osobistych",
        "  akt · obowiązuje · akt posiada tekst jednolity · Dz. U. z 2010 r. Nr 167, poz. 1131 · https://eli.gov.pl/eli/DU/2010/1131/ogl",
    ]);
    expect(JSON.parse((await run("search", "o dowodach osobistych", "--json")).text)).toMatchObject({
        total: 21,
        items: [
            { ELI: "DU/2010/1131", kind: "act", eli: "https://eli.gov.pl/eli/DU/2010/1131/ogl" },
            { ELI: "DU/1974/85", kind: "act", inForce: "NOT_IN_FORCE" },
            { ELI: "DU/2021/1978", kind: "amendment" },
            { ELI: "DU/2011/768", kind: "amendment" },
        ],
    });
});

test("a title in the wrong case is searched again by its stems", async () => {
    const { run, urls } = harness(root, { override: (url) => (url.includes("title=instrukcja") ? JSON.stringify({ totalCount: 0, items: [] }) : undefined) });
    const result = await run("search", "instrukcja kancelaryjna");
    expect(new URL(urls[1] ?? "").searchParams.get("title")).toBe("instruk kancelary");
    expect(result.text.split("\n")[0]).toBe("Dokładne słowa nic nie dały; szukano rdzeni: „instruk kancelary”.");
});

test("show tells the act's status, its newest consolidated text and the amendment that text lacks", async () => {
    const { run } = harness(root);
    const result = await run("show", "DU/2010/1131");
    expect(result.text).toContain("Status: obowiązuje (akt posiada tekst jednolity); wszedł w życie 2015-03-01");
    expect(result.text).toContain("Tekst jednolity: Dz. U. z 2025 r. poz. 1753 (DU/2025/1753) — obwieszczenie z 2025-11-27, stan prawny na 2025-11-24");
    expect(result.text).toContain("- DU/2026/1206 (wejdzie w życie 2027-01-11) — Ustawa z dnia 31 lipca 2026 r. o zmianie ustawy - Prawo bankowe");
    // A change not yet in force adds no "z późn. zm." to the citation.
    expect(result.text).toContain("Cytat: Ustawa z dnia 6 sierpnia 2010 r. o dowodach osobistych (Dz. U. z 2025 r. poz. 1753)");
    const repealed = await run("show", "https://eli.gov.pl/eli/DU/1974/85/ogl");
    expect(repealed.text).toContain("Uwaga: akt nie obowiązuje od 2015-03-01; uchylił go DU/2010/1131");
    expect(repealed.text).toContain("Ostatni tekst jednolity: DU/2006/993");
});

test("article quotes a unit of the consolidated PDF with its citation, source and status", async () => {
    const { run } = harness(root);
    const result = await run("article", "DU/1960/168", "35", "§", "3a");
    expect(result.code).toBe(0);
    expect(result.text.split("\n")).toEqual([
        "## Art. 35 § 3a · Ustawa z dnia 14 czerwca 1960 r. Kodeks postępowania administracyjnego.",
        "DZIAŁ I — Przepisy ogólne / Rozdział 7 — Załatwianie spraw",
        "",
        "[Art. 35 § 3a] § 3a. Załatwienie sprawy w postępowaniu uproszczonym powinno nastąpić niezwłocznie, nie później niż w terminie miesiąca od dnia wszczęcia postępowania.",
        "",
        "Cytat: art. 35 § 3a ustawy z dnia 14 czerwca 1960 r. – Kodeks postępowania administracyjnego (Dz. U. z 2025 r. poz. 1691)",
        "Źródło: tekst jednolity Dz. U. z 2025 r. poz. 1691 — obwieszczenie z 2025-11-07, stan prawny na 2025-11-03; ELI https://eli.gov.pl/eli/DU/1960/168/ogl; plik: https://api.sejm.gov.pl/eli/acts/DU/2025/1691/text.pdf",
        "Akt: obowiązuje.",
    ]);
    expect(JSON.parse((await run("article", "DU/1960/168", "39^1", "--json")).text)).toMatchObject({
        source: "consolidated",
        citation: "art. 39¹ ustawy z dnia 14 czerwca 1960 r. – Kodeks postępowania administracyjnego (Dz. U. z 2025 r. poz. 1691)",
        articles: [{ units: [{ marker: "Art. 39¹" }, { marker: "Art. 39¹ pkt 1" }, { marker: "Art. 39¹ pkt 2" }] }],
    });
});

test("a consolidated text with HTML is read from the HTML, a footnote as a note of its paragraph", async () => {
    // The KPA as ELI described it before the 2025 consolidation, when the newest consolidated text (2024) had HTML.
    const kpa = ActSchema.parse(JSON.parse(fixture("eli-act-kpa.json")));
    const in2024 = { ...kpa, references: { ...kpa.references, "Inf. o tekście jednolitym": [{ id: "DU/2024/572" }] } };
    const { run, urls } = harness(root, { override: (url) => (url.endsWith("/DU/1960/168") ? JSON.stringify(in2024) : undefined) });
    const result = await run("article", "DU/1960/168", "127", "§", "1a");
    expect(result.text).toContain("[Art. 127 § 1a] § 1a. Decyzja wydana w pierwszej instancji, od której uzasadnienia organ odstąpił");
    expect(result.text).toContain("> Przypis (Art. 127 § 1a): 2) Dodany przez art. 1 pkt 1 ustawy z dnia 26 stycznia 2023 r.");
    // Seen from then, the 2025 amendment already in force is not in that text: the citation says so, and the status line
    // names it.
    expect(result.text).toContain("Cytat: art. 127 § 1a ustawy z dnia 14 czerwca 1960 r. – Kodeks postępowania administracyjnego (Dz. U. z 2024 r. poz. 572, z późn. zm.)");
    expect(result.text).toContain("Akt: obowiązuje; zmiany w życiu po tym tekście: DU/2025/769 (2025-07-13) — sprawdź, czy dotyczą przepisu.");
    expect(urls.some((url) => url.endsWith(".pdf"))).toBe(false);
});

test("a text read once is answered from the cache, offline", async () => {
    const online = harness(root);
    const first = await online.run("article", "DU/2010/1131", "31", "ust.", "2", "pkt", "8");
    expect(first.text).toContain("[Art. 31 ust. 2 pkt 8] 8) podpis osoby, której wydano dowód osobisty");
    expect(first.text).toContain("> Przypis (Art. 31 ust. 2 pkt 8): 12) W brzmieniu ustalonym przez art. 37 pkt 6 lit. a");
    expect(first.text).toContain("Akt: obowiązuje; zmiany oczekujące: DU/2026/1206 (od 2027-01-11).");
    expect(await readdir(join(root, "texts"))).toEqual(["consolidated-DU-2025-1753-v5.json"]);
    // Within the twelve hours metadata stays fresh, nothing is asked of the network at all.
    const quiet = harness(root, { override: offline });
    expect(await quiet.run("article", "DU/2010/1131", "31", "ust.", "2", "pkt", "8")).toEqual(first);
    expect(quiet.urls).toEqual([]);
    // Told to refresh with the network down, the copy answers and says it is one.
    const refreshed = await harness(root, { override: offline }).run("show", "DU/2010/1131", "--refresh");
    expect(refreshed.code).toBe(0);
});

test("the unified text is marked as such and cited by the consolidated text it builds on", async () => {
    const { run } = harness(root);
    const result = await run("article", "DU/2010/1131", "68a", "--unified");
    expect(result.text).toContain("Uwaga: Tekst ujednolicony Kancelarii Sejmu: aktualny, ale bez mocy prawnej");
    expect(result.text).toContain("> Przypis: Nowe brzmienie pkt 3 w ust. 1 w art. 68a wejdzie w życie z dn. 11.01.2027 r. (Dz. U. z 2026 r. poz. 1206).");
    expect(result.text).toContain("Cytat: art. 68a ustawy z dnia 6 sierpnia 2010 r. o dowodach osobistych (Dz. U. z 2025 r. poz. 1753)");
    expect(result.text).toContain("Źródło: tekst ujednolicony (Kancelaria Sejmu, bez mocy prawnej); Opracowano na podstawie: t.j. Dz. U. z 2025 r. poz. 1753, z 2026 r. poz. 1206.");
});

test("a regulation's annex is quoted and cited through the annex", async () => {
    const { run } = harness(root);
    const result = await run("article", "DU/2011/67", "zał.", "1", "§", "5", "ust.", "3", "pkt", "2");
    expect(result.text).toContain("[Załącznik nr 1 § 5 ust. 3 pkt 2] 2) symbol klasyfikacyjny z wykazu akt;");
    expect(result.text).toContain("Cytat: § 5 ust. 3 pkt 2 załącznika nr 1 do rozporządzenia Prezesa Rady Ministrów z dnia 18 stycznia 2011 r. w sprawie instrukcji kancelaryjnej");
    const missing = await run("article", "DU/2011/67", "9");
    expect(missing.code).toBe(2);
    expect(missing.text).toContain("prawo: no article 9 in DU/2011/67");
});

test("rulings are searched newest first up to today, and each carries its citation and SAOS's coverage", async () => {
    const { run, urls } = harness(root);
    const result = await run("rulings", "search", "bezczynność organu", "--act", "DU/1960/168", "--court", "common", "--limit", "2");
    expect(Object.fromEntries(new URL(urls[0] ?? "").searchParams)).toEqual({
        all: "bezczynność organu",
        lawJournalEntryCode: "1960/168",
        courtType: "COMMON",
        judgmentDateTo: TODAY,
        pageSize: "2",
        sortingField: "JUDGMENT_DATE",
        sortingDirection: "DESC",
    });
    expect(result.text).toContain("- Sąd Okręgowy w Lublinie, wyrok z dnia 14 sierpnia 2026 r., sygn. akt VIII Pa 201/25; SAOS: https://www.saos.org.pl/judgments/552277");
    expect(result.text).toContain("**bezczynności**");
    expect(result.text).toContain("bez sądów administracyjnych (NSA i WSA: orzeczenia.nsa.gov.pl)");
    const shown = await run("rulings", "show", "552277");
    expect(shown.text).toContain("Teza: w sprawach funkcjonariuszy służby celnej o uposażenie");
    expect(shown.text).toContain("- Ustawa z dnia 14 czerwca 1960 r. - Kodeks postępowania administracyjnego (Dz. U. z 1960 r. Nr 30, poz. 168 - art. 104; art. 104 § 1; art. 104 § 2)");
    expect(shown.text).toContain("\nWYROK\nW IMIENIU RZECZYPOSPOLITEJ POLSKIEJ\n");
    expect(shown.text).toContain("Cytat: Sąd Okręgowy w Lublinie, wyrok z dnia 14 sierpnia 2026 r., sygn. akt VIII Pa 201/25");
});

test("a mistake is answered on stdout with exit 2, never as an empty answer", async () => {
    const { run } = harness(root);
    expect(await run("search", "kodeks", "--repeald")).toEqual({ code: 2, text: "prawo: unknown flag --repeald (prawo --help lists them)" });
    expect((await run("show", "Dz.U. 1960 nr 30")).text).toMatch(/^prawo: "Dz\.U\. 1960 nr 30" is not an act address/u);
    expect((await run("rulings", "search", "x", "--act", "MP/2024/5")).text).toBe("prawo: --act links rulings through Dziennik Ustaw only (DU/<year>/<position>)");
    expect(await run()).toMatchObject({ code: 0, text: expect.stringMatching(/^prawo — Polish acts/u) });
});
