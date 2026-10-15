import type { Act } from "../sources/eli.js";
import { actCitation, actName, journalAddress, polishDate, rulingCitation } from "./citation.js";

const act = (fields: Partial<Act>): Act => ({ ELI: "DU/1960/168", publisher: "DU", year: 1960, pos: 168, title: "", type: "Ustawa", displayAddress: "", ...fields });

const kpa = act({ volume: 30, title: "Ustawa z dnia 14 czerwca 1960 r. Kodeks postępowania administracyjnego." });
const consolidated = act({ ELI: "DU/2025/1691", year: 2025, pos: 1691, volume: 0, type: "Obwieszczenie" });

test("a journal address names the issue before 2012 and only the position after", () => {
    expect(journalAddress(kpa)).toBe("Dz. U. z 1960 r. Nr 30, poz. 168");
    expect(journalAddress(consolidated)).toBe("Dz. U. z 2025 r. poz. 1691");
    expect(journalAddress(act({ publisher: "MP", year: 2024, pos: 5 }))).toBe("M. P. z 2024 r. poz. 5");
});

test("a provision is cited through the act's name in the genitive and its newest consolidated text", () => {
    expect(actName(kpa)).toBe("ustawy z dnia 14 czerwca 1960 r. – Kodeks postępowania administracyjnego");
    expect(actCitation({ act: kpa, basis: consolidated, laterAmendments: false }, "Art. 35 § 1")).toBe(
        "art. 35 § 1 ustawy z dnia 14 czerwca 1960 r. – Kodeks postępowania administracyjnego (Dz. U. z 2025 r. poz. 1691)",
    );
    expect(actCitation({ act: kpa, basis: consolidated, laterAmendments: true })).toBe(
        "Ustawa z dnia 14 czerwca 1960 r. – Kodeks postępowania administracyjnego (Dz. U. z 2025 r. poz. 1691, z późn. zm.)",
    );
    const regulation = act({ type: "Rozporządzenie", title: "Rozporządzenie Prezesa Rady Ministrów z dnia 18 stycznia 2011 r. w sprawie instrukcji kancelaryjnej" });
    expect(actCitation({ act: regulation, basis: regulation, laterAmendments: false }, "Załącznik nr 1 § 5 ust. 3")).toMatch(
        /^§ 5 ust\. 3 załącznika nr 1 do rozporządzenia Prezesa Rady Ministrów z dnia 18 stycznia 2011 r\. w sprawie instrukcji kancelaryjnej \(/u,
    );
});

test("a ruling is cited by court, form, date and case number, with its SAOS address", () => {
    expect(polishDate("2026-08-14")).toBe("14 sierpnia 2026 r.");
    expect(
        rulingCitation({
            id: 552277,
            courtType: "COMMON",
            judgmentType: "SENTENCE",
            judgmentDate: "2026-08-14",
            courtCases: [{ caseNumber: "VIII Pa 201/25" }],
            division: { name: "VIII Wydział Pracy i Ubezpieczeń Społecznych", court: { name: "Sąd Okręgowy w Lublinie" } },
        }),
    ).toBe("Sąd Okręgowy w Lublinie, wyrok z dnia 14 sierpnia 2026 r., sygn. akt VIII Pa 201/25; SAOS: https://www.saos.org.pl/judgments/552277");
    expect(rulingCitation({ id: 1, courtType: "CONSTITUTIONAL_TRIBUNAL", judgmentType: "DECISION", courtCases: [{ caseNumber: "K 7/94" }] })).toBe(
        "Trybunał Konstytucyjny, postanowienie, sygn. akt K 7/94; SAOS: https://www.saos.org.pl/judgments/1",
    );
});
