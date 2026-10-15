import type { Act } from "../sources/eli.js";
import type { Hit } from "../sources/saos.js";

/* HOW A POLISH LEGAL TEXT IS CITED. An act by its journal address ("Dz. U. z 2025 r. poz. 1691", before 2012 with the
   issue: "Dz. U. z 2010 r. Nr 167, poz. 1131"); a provision as "art. 35 § 1 ustawy z dnia 14 czerwca 1960 r. – Kodeks
   postępowania administracyjnego (Dz. U. z 2025 r. poz. 1691)", naming the newest consolidated text and adding "z późn.
   zm." when amendments took effect after it; a ruling by court, form, date and case number. The wording is Polish
   whatever language the reader uses: it is quoted into Polish documents. */

const MONTHS = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];

// "2026-08-14" → "14 sierpnia 2026 r.", the form an official document uses.
export const polishDate = (iso: string): string => {
    const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(iso);
    if (match === null) {
        return iso;
    }
    return `${String(Number(match[3]))} ${MONTHS[Number(match[2]) - 1] ?? ""} ${match[1] ?? ""} r.`;
};

const JOURNALS: ReadonlyMap<string, string> = new Map([
    ["DU", "Dz. U."],
    ["MP", "M. P."],
]);

export const journalAddress = (act: Act): string => {
    const journal = JOURNALS.get(act.publisher) ?? act.publisher;
    const issue = act.volume !== undefined && act.volume > 0 ? `Nr ${String(act.volume)}, ` : "";
    return `${journal} z ${String(act.year)} r. ${issue}poz. ${String(act.pos)}`;
};

export const eliUri = (act: Pick<Act, "ELI">): string => `https://eli.gov.pl/eli/${act.ELI}/ogl`;
export const isapUrl = (act: Act): string | undefined =>
    act.address === undefined ? undefined : `https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=${act.address}`;

const GENITIVE: ReadonlyMap<string, string> = new Map([
    ["Ustawa", "ustawy"],
    ["Rozporządzenie", "rozporządzenia"],
    ["Obwieszczenie", "obwieszczenia"],
    ["Uchwała", "uchwały"],
    ["Zarządzenie", "zarządzenia"],
    ["Dekret", "dekretu"],
    ["Konstytucja", "Konstytucji"],
    ["Umowa", "umowy"],
    ["Regulamin", "regulaminu"],
]);

// The act's title as it stands after a provision: "ustawy z dnia 14 czerwca 1960 r. – Kodeks postępowania
// administracyjnego", the type in the genitive and a code's name set off by a dash.
export const actName = (act: Act, inGenitive = true): string => {
    const title = act.title.replace(/\.$/u, "").replaceAll(/\s+-\s+/gu, " – ");
    const [first = "", ...rest] = title.split(" ");
    const named = [inGenitive ? (GENITIVE.get(first) ?? first) : first, ...rest].join(" ");
    return named.replace(/(\d{4} r\.) (?=\p{Lu})/u, "$1 – ");
};

// The marker as it reads inside a sentence: "Art. 35 § 1" → "art. 35 § 1".
const inSentence = (marker: string): string => marker.replace(/^Art\./u, "art.");

export interface CitationParts {
    readonly act: Act;
    // The text the wording came from: the newest consolidated text when there is one, else the act itself.
    readonly basis: Act;
    // Whether an amendment that is already in force came after `basis`.
    readonly laterAmendments: boolean;
}

export const actCitation = ({ act, basis, laterAmendments }: CitationParts, marker?: string): string => {
    const where = `${journalAddress(basis)}${laterAmendments ? ", z późn. zm." : ""}`;
    if (marker === undefined) {
        return `${actName(act, false)} (${where})`;
    }
    // A provision of an annex is cited through it: "§ 5 ust. 2 załącznika nr 1 do rozporządzenia …".
    const annex = /^Załącznik nr (\S+) (.*)$/u.exec(marker);
    const provision = annex === null ? inSentence(marker) : `${annex[2] ?? ""} załącznika nr ${annex[1] ?? ""} do`;
    return `${provision} ${actName(act)} (${where})`;
};

const RULING_FORMS: ReadonlyMap<string, string> = new Map([
    ["SENTENCE", "wyrok"],
    ["DECISION", "postanowienie"],
    ["RESOLUTION", "uchwała"],
    ["REASONS", "uzasadnienie"],
    ["REGULATION", "zarządzenie"],
]);

const COURTS: ReadonlyMap<string, string> = new Map([
    ["SUPREME", "Sąd Najwyższy"],
    ["CONSTITUTIONAL_TRIBUNAL", "Trybunał Konstytucyjny"],
    ["NATIONAL_APPEAL_CHAMBER", "Krajowa Izba Odwoławcza"],
    ["ADMINISTRATIVE", "Sąd administracyjny"],
]);

export const courtName = (hit: Hit): string => {
    const court = hit.division?.court?.name ?? COURTS.get(hit.courtType) ?? hit.courtType;
    const chamber = hit.division?.chambers?.[0]?.name;
    return chamber === undefined ? court : `${court}, ${chamber}`;
};

export const saosUrl = (id: number): string => `https://www.saos.org.pl/judgments/${String(id)}`;

export const rulingCitation = (hit: Hit): string => {
    const form = RULING_FORMS.get(hit.judgmentType ?? "") ?? "orzeczenie";
    const date = hit.judgmentDate === undefined || hit.judgmentDate === null ? "" : ` z dnia ${polishDate(hit.judgmentDate)}`;
    const cases = (hit.courtCases ?? []).map((entry) => entry.caseNumber).join(", ");
    return `${courtName(hit)}, ${form}${date}${cases === "" ? "" : `, sygn. akt ${cases}`}; SAOS: ${saosUrl(hit.id)}`;
};
