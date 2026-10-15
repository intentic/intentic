import { readFileSync } from "node:fs";
import { articlesFromPdfText } from "./pdf.js";
import { type Article, findArticle, notesFor, selectUnits } from "./model.js";

// Real `fileq read --plain` output of the Sejm's PDFs, trimmed to a few pages each: the consolidated KPA of 2025, the
// consolidated act on identity cards of 2025, the Chancellery's unified text of the same act, and a 2011 regulation
// whose substance is in its annexes.
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const kpa = articlesFromPdfText(fixture("kpa-tj-2025.pdf.md"));
const dowody = articlesFromPdfText(fixture("dowody-tj-2025.pdf.md"));
const unified = articlesFromPdfText(fixture("dowody-unified.pdf.md"), { unified: true });
const regulation = articlesFromPdfText(fixture("instrukcja-2011.pdf.md"));

const article = (text: { readonly articles: Article[] }, key: string): Article => {
    const found = findArticle(text, key);
    if (found === undefined) {
        throw new Error(`no ${key} among ${text.articles.map((entry) => entry.number).join(" ")}`);
    }
    return found;
};
const lines = (found: Article): string[] => found.units.map((unit) => `[${unit.marker}] ${unit.label} ${unit.text}`.replace(/\] {2}/u, "] "));

test("a consolidated text starts after its announcement, which is kept as the notice", () => {
    expect(kpa.notice).toContain("nie obejmuje art. 31 ust. 1 i art. 48 ustawy z dnia 21 maja 2025 r.");
    expect(kpa.articles[0]?.marker).toBe("Art. 1");
    // The announcement quotes the amending act's "Art. 31." and "Art. 48."; neither becomes an article of the code.
    expect(article(kpa, "31").units[0]?.text).not.toContain("Do spraw prowadzonych na podstawie ustawy zmienianej");
});

test("paragraphs carry stable markers and their wording across a page break, without the running head", () => {
    expect(lines(article(kpa, "35"))).toEqual([
        "[Art. 35 § 1] § 1. Organy administracji publicznej obowiązane są załatwiać sprawy bez zbędnej zwłoki.",
        expect.stringContaining("[Art. 35 § 2] § 2. Niezwłocznie powinny być załatwiane sprawy"),
        expect.stringContaining("[Art. 35 § 3] § 3. Załatwienie sprawy wymagającej postępowania wyjaśniającego powinno nastąpić nie później niż w ciągu miesiąca"),
        "[Art. 35 § 3a] § 3a. Załatwienie sprawy w postępowaniu uproszczonym powinno nastąpić niezwłocznie, nie później niż w terminie miesiąca od dnia wszczęcia postępowania.",
        "[Art. 35 § 4] § 4. Przepisy szczególne mogą określać inne terminy niż określone w § 3 i 3a.",
        expect.stringContaining("[Art. 35 § 5] § 5. Do terminów określonych w przepisach poprzedzających"),
    ]);
    expect(kpa.articles.flatMap((entry) => entry.units).some((unit) => /Dziennik Ustaw|Poz\. 1691/u.test(unit.text))).toBe(false);
    // "w po-" / "stępowaniu" across a line break reads as one word.
    expect(article(kpa, "35").units[2]?.text).toContain("zaś w postępowaniu odwoławczym");
});

test("an article number the PDF layer flattened is read back as raised", () => {
    const raised = article(kpa, "39^1");
    expect(raised.marker).toBe("Art. 39¹");
    expect(lines(raised).slice(1)).toEqual([
        expect.stringMatching(/^\[Art\. 39¹ pkt 1\] 1\) adres do doręczeń elektronicznych .* albo$/u),
        expect.stringMatching(/^\[Art\. 39¹ pkt 2\] 2\) adres do doręczeń elektronicznych powiązany/u),
    ]);
    expect(findArticle(kpa, "391")).toBeUndefined();
});

test("footnotes leave the wording and stay as notes of the unit they mark", () => {
    const added = article(kpa, "45a");
    expect(added.units[0]?.text.startsWith("W przypadku braku możliwości doręczenia pisma")).toBe(true);
    expect(added.notes).toEqual([{ marker: "Art. 45a", text: expect.stringMatching(/^3\) Dodany przez art\. 1 pkt 1 ustawy z dnia 21 maja 2025 r\..*weszła w życie z dniem 13 lipca 2025 r\.$/u) }]);
    // A footnote listing a cited act's own amendments says nothing about this provision.
    expect(article(kpa, "3").notes).toEqual([]);
    expect(article(kpa, "3").units.find((unit) => unit.marker === "Art. 3 § 1 pkt 2")?.text).toContain("(Dz. U. z 2025 r. poz. 111, z późn. zm.), z wyjątkiem");
});

test("a list point that looks like a footnote stays a point", () => {
    expect(lines(article(kpa, "3")).filter((line) => line.startsWith("[Art. 3 § 2 pkt"))).toEqual([
        "[Art. 3 § 2 pkt 1] 1) (uchylony)",
        "[Art. 3 § 2 pkt 2] 2) (uchylony)",
        "[Art. 3 § 2 pkt 3] 3) (uchylony)",
        "[Art. 3 § 2 pkt 4] 4) należących do właściwości polskich przedstawicielstw dyplomatycznych i urzędów konsularnych, o ile przepisy szczególne nie stanowią inaczej.",
    ]);
});

test("a repealed range and the chapter an article sits in are kept", () => {
    expect(article(kpa, "164-179").marker).toBe("Art. 164–179");
    expect(article(kpa, "35").heading).toBe("DZIAŁ I — Przepisy ogólne / Rozdział 7 — Załatwianie spraw");
    expect(article(kpa, "269").units[0]?.text).toContain("Decyzje określone w innych przepisach prawnych jako prawomocne");
});

test("passages and points of a statute numbered by ustęp, with a footnote glued to a point", () => {
    const pickup = article(dowody, "31");
    expect(selectUnits(pickup, "ust. 2 pkt 3").map((unit) => `${unit.label} ${unit.text}`)).toEqual(["3) serię i numer dowodu osobistego;"]);
    expect(selectUnits(pickup, "ust. 2 pkt 8")[0]?.text).toBe("podpis osoby, której wydano dowód osobisty, złożony w sposób, o którym mowa w art. 24 ust. 3;");
    expect(notesFor(pickup, "ust. 2 pkt 8").map((note) => note.text)).toEqual([expect.stringMatching(/^12\) W brzmieniu ustalonym przez art\. 37 pkt 6 lit\. a/u)]);
    expect(notesFor(pickup, "ust. 3").map((note) => note.text)).toEqual([expect.stringMatching(/^13\) Dodany przez art\. 37 pkt 6 lit\. b/u)]);
});

test("a unified text gives its basis, and a margin note to the article beside it", () => {
    expect(unified.basis).toBe("Opracowano na podstawie: t.j. Dz. U. z 2025 r. poz. 1753, z 2026 r. poz. 1206.");
    expect(unified.notice).toBeUndefined();
    expect(article(unified, "2").heading).toBe("Rozdział 1 — Przepisy ogólne");
    expect(article(unified, "68a").notes.map((note) => note.text)).toContain(
        "Nowe brzmienie pkt 3 w ust. 1 w art. 68a wejdzie w życie z dn. 11.01.2027 r. (Dz. U. z 2026 r. poz. 1206).",
    );
});

test("a regulation is read by paragraphs, its annexes as parts of their own", () => {
    expect(regulation.articles.map((entry) => entry.number)).toEqual(["1", "2", "z1:1", "z1:2", "z1:3", "z1:4", "z1:5", "z6:1", "z6:2", "z6:3"]);
    expect(lines(article(regulation, "1")).slice(0, 2)).toEqual(["[§ 1 ust. 1] 1. Rozporządzenie określa:", "[§ 1 ust. 1 pkt 1] 1) instrukcję kancelaryjną,"]);
    const caseSign = article(regulation, "z1:5");
    expect(caseSign.marker).toBe("Załącznik nr 1 § 5");
    expect(selectUnits(caseSign, "ust. 3 pkt 2").map((unit) => unit.text)).toEqual(["symbol klasyfikacyjny z wykazu akt;"]);
});
