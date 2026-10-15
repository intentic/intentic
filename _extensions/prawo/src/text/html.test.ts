import { readFileSync } from "node:fs";
import { articlesFromHtml, htmlLines } from "./html.js";
import { type Article, findArticle, notesFor, selectUnits } from "./model.js";

// Real HTML from the Sejm's ELI API, trimmed by whole units: the 2024 consolidated KPA (announcement, annex, footnote
// tooltips, raised article numbers) and Art. 31 of the act on identity cards as first published in 2010.
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const kpa = articlesFromHtml(fixture("kpa-tj-2024.html"));
const dowody = articlesFromHtml(fixture("dowody-2010-art31.html"));

const article = (key: string, text = kpa): Article => {
    const found = findArticle(text, key);
    if (found === undefined) {
        throw new Error(`no ${key} among ${text.articles.map((entry) => entry.number).join(" ")}`);
    }
    return found;
};

test("only the annex is the act: the announcement's quoted articles are not read as the code's", () => {
    expect(kpa.articles.map((entry) => entry.marker)).toEqual(["Art. 2", "Art. 35", "Art. 37", "Art. 39", "Art. 39¹", "Art. 39²", "Art. 127", "Art. 127a"]);
    expect(kpa.notice).toContain("tekst jednolity ustawy nie obejmuje art. 17 i art. 24 ustawy z dnia 26 stycznia 2023 r.");
});

test("units nest as the page nests them, closing words of a list included", () => {
    const ponaglenie = article("37");
    expect(ponaglenie.units.slice(0, 3).map((unit) => `[${unit.marker}] ${unit.label} ${unit.text}`)).toEqual([
        "[Art. 37 § 1] § 1. Stronie służy prawo do wniesienia ponaglenia, jeżeli:",
        expect.stringMatching(/^\[Art\. 37 § 1 pkt 1\] 1\) nie załatwiono sprawy w terminie/u),
        expect.stringMatching(/^\[Art\. 37 § 1 pkt 2\] 2\) postępowanie jest prowadzone dłużej/u),
    ]);
    expect(article("35").heading).toBe("Dział I — Przepisy ogólne / Rozdział 7 — Załatwianie spraw");
});

test("a footnote's tooltip becomes a note of the paragraph it marks, not part of its wording", () => {
    const appeal = article("127");
    expect(selectUnits(appeal, "§ 1a").map((unit) => unit.text)).toEqual([
        "Decyzja wydana w pierwszej instancji, od której uzasadnienia organ odstąpił z powodu uwzględnienia w całości żądania strony, jest ostateczna.",
    ]);
    expect(notesFor(appeal, "§ 1a")).toEqual([{ marker: "Art. 127 § 1a", text: expect.stringMatching(/^2\) Dodany przez art\. 1 pkt 1 ustawy z dnia 26 stycznia 2023 r\./u) }]);
    expect(notesFor(appeal, "§ 2")).toEqual([]);
    expect(article("127a").notes).toEqual([{ marker: "Art. 127a § 1", text: "3) W brzmieniu ustalonym przez art. 1 pkt 2 ustawy, o której mowa w odnośniku 2." }]);
    // A citation the page wraps in a link reads as the act prints it.
    expect(selectUnits(article("35"), "§ 5")[0]?.text).toContain("o doręczeniach elektronicznych (Dz. U. z 2023 r. poz. 285, 1860 i 2699), okresów zawieszenia");
});

test("an act numbered by ustęp, as first published", () => {
    const pickup = article("31", dowody);
    expect(pickup.units.map((unit) => unit.marker)).toEqual([
        "Art. 31 ust. 1",
        "Art. 31 ust. 2",
        ...Array.from({ length: 9 }, (_, index) => `Art. 31 ust. 2 pkt ${String(index + 1)}`),
    ]);
    // The wording before the 2023 amendment: a handwritten signature.
    expect(selectUnits(pickup, "ust. 2 pkt 8")[0]?.text).toBe("własnoręczny czytelny podpis osoby, której wydano dowód osobisty;");
});

test("a ruling's HTML reads as its paragraphs", () => {
    expect(htmlLines("<p>Sygn. akt VIII Pa 201/25</p><div><h2>WYROK</h2><p> Dnia 14&nbsp;sierpnia 2026 roku</p></div>")).toEqual([
        "Sygn. akt VIII Pa 201/25",
        "WYROK",
        "Dnia 14 sierpnia 2026 roku",
    ]);
});
