/* AN ACT'S TEXT AS ARTICLES: the shape both readers (html.ts, pdf.ts) produce, its numbering, and the markers a quote
   is cited by ("Art. 5 ust. 2 pkt 3", "Art. 35 § 1", "§ 4 ust. 1"). */

// One addressable line of an article: its marker, the label the act itself prints ("§ 1.", "2.", "3)", "a)", "–"), and
// the wording after it. An article without subdivisions is one unit whose marker is the article's own.
export interface Unit {
    readonly marker: string;
    readonly label: string;
    text: string;
}

// A footnote or margin note, and the unit it was printed against: the article itself, or "Art. 31 ust. 3".
export interface Note {
    readonly marker: string;
    readonly text: string;
}

export interface Article {
    // Canonical number, the key lookups normalise to: "35", "45a", "39^1", "22^1a", "164-179".
    readonly number: string;
    // As cited: "Art. 35", "Art. 39¹", "§ 4" in a regulation, whose basic unit is the paragraph.
    readonly marker: string;
    // The division, chapter and section the article sits in, "Dział II / Rozdział 7 — Decyzje", when the text says.
    readonly heading?: string | undefined;
    readonly units: Unit[];
    // Footnotes and margin notes the text attaches to it: who added or changed it, and when that takes effect.
    readonly notes: Note[];
}

export interface ParsedText {
    readonly articles: Article[];
    // An announcement's own wording (the "obwieszczenie" in front of a consolidated text): which amendments it covers
    // and which provisions it leaves out.
    readonly notice?: string | undefined;
    // What a unified text was compiled from ("Opracowano na podstawie: t.j. Dz. U. z 2025 r. poz. 1753, …").
    readonly basis?: string | undefined;
}

const SUPERSCRIPT = new Map(
    Object.entries({
        "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
        a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ",
        p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
    }),
);
const PLAIN = new Map([...SUPERSCRIPT].map(([plain, raised]) => [raised, plain]));
const RAISED = new RegExp(`[${[...PLAIN.keys()].join("")}]+`, "gu");

// "1a" → "¹ᵃ", for an article number Polish acts print raised (art. 39¹, art. 22¹ᵃ).
export const superscript = (value: string): string => [...value].map((char) => SUPERSCRIPT.get(char) ?? char).join("");

// Every spelling of an article number an agent or a text uses, to the one key: "Art. 39¹", "39^1", "39[1]", "39(1)" and
// "39_1" are all "39^1"; "164–179" is "164-179".
export const articleKey = (raw: string): string =>
    raw
        .trim()
        .replace(/^(?:art\.?|§)\s*/iu, "")
        .replace(RAISED, (raised) => `^${[...raised].map((char) => PLAIN.get(char) ?? char).join("")}`)
        .replace(/\[(\w+)\]|\((\d\w*)\)|_(\w+)/gu, (_, bracket?: string, paren?: string, under?: string) => `^${bracket ?? paren ?? under ?? ""}`)
        .replace(/\s*[–-]\s*/gu, "-")
        .replace(/\.$/u, "")
        .replaceAll(/\s+/gu, "")
        .toLowerCase();

// The key as an act prints it: "39^1" → "39¹", "164-179" → "164–179".
export const displayNumber = (key: string): string =>
    key
        .split("-")
        .map((part) => part.replace(/\^(\w+)/u, (_, raised: string) => superscript(raised)))
        .join("–");

export type TopUnit = "art" | "par";
export const articleMarker = (top: TopUnit, key: string): string => `${top === "art" ? "Art." : "§"} ${displayNumber(key)}`;

// A number's place in its sequence, for telling a heading from a stray line: the leading integer, then what follows it.
const ordinal = (value: string): readonly [number, string] => {
    const match = /^(\d+)(.*)$/u.exec(value);
    return match === null ? [Number.NaN, value] : [Number(match[1]), match[2] ?? ""];
};
export const follows = (next: string, previous: string | undefined): boolean => {
    if (previous === undefined) {
        return true;
    }
    const [nextBase, nextRest] = ordinal(next);
    const [previousBase, previousRest] = ordinal(previous);
    return nextBase > previousBase || (nextBase === previousBase && nextRest > previousRest);
};

export type Level = "par" | "ust" | "pkt" | "lit" | "tiret";
const LEVELS: readonly Level[] = ["par", "ust", "pkt", "lit", "tiret"];

// Builds one article's units in reading order, composing each marker from the subdivisions it sits in: a point under
// `§ 2` is "Art. 3 § 2 pkt 1", under `ust. 2` "Art. 31 ust. 2 pkt 1".
export class ArticleBuilder {
    readonly units: Unit[] = [];
    private readonly notes: Note[] = [];
    private readonly path = new Map<Level, string>();
    private tirets = 0;

    constructor(
        readonly number: string,
        readonly marker: string,
        readonly heading: string | undefined,
    ) {}

    current(level: Level): string | undefined {
        return this.path.get(level);
    }

    // Opens a subdivision: `value` is its number ("2", "1a", "b"), `label` what the act prints for it ("2.", "b)").
    open(level: Level, value: string, label: string): Unit {
        for (const deeper of LEVELS.slice(LEVELS.indexOf(level))) {
            this.path.delete(deeper);
        }
        if (level === "tiret") {
            this.tirets += 1;
        } else {
            this.tirets = 0;
            this.path.set(level, value);
        }
        const unit: Unit = { marker: this.markerAt(level), label, text: "" };
        this.units.push(unit);
        return unit;
    }

    // Wording that belongs to `unit`, or to the article itself when undefined. Written after a deeper unit, it is the
    // closing text of a list ("o ile przepisy szczególne nie stanowią inaczej"), so it gets a line of its own.
    write(unit: Unit | undefined, text: string): void {
        const marker = unit?.marker ?? this.marker;
        const last = this.units.at(-1);
        if (last !== undefined && (last === unit || (unit === undefined && last.marker === marker))) {
            last.text = joinLine(last.text, text);
            return;
        }
        this.units.push({ marker, label: "", text });
    }

    // The next line of a page, continuing whatever was written last.
    continue(text: string): void {
        this.write(this.units.at(-1), text);
    }

    // A note about the unit written last, or about the whole article.
    note(text: string, whole = false): void {
        const marker = whole ? this.marker : (this.units.at(-1)?.marker ?? this.marker);
        if (!this.notes.some((note) => note.marker === marker && note.text === text)) {
            this.notes.push({ marker, text });
        }
    }

    build(): Article {
        return { number: this.number, marker: this.marker, heading: this.heading, units: this.units, notes: this.notes };
    }

    private markerAt(level: Level): string {
        const parts = [this.marker];
        const par = this.path.get("par");
        const ust = this.path.get("ust");
        const pkt = this.path.get("pkt");
        const lit = this.path.get("lit");
        if (par !== undefined) {
            parts.push(`§ ${par}`);
        }
        if (ust !== undefined && level !== "par") {
            parts.push(`ust. ${ust}`);
        }
        if (pkt !== undefined && (level === "pkt" || level === "lit" || level === "tiret")) {
            parts.push(`pkt ${pkt}`);
        }
        if (lit !== undefined && (level === "lit" || level === "tiret")) {
            parts.push(`lit. ${lit}`);
        }
        if (level === "tiret") {
            parts.push(`tiret ${String(this.tirets)}`);
        }
        return parts.join(" ");
    }
}

// Two lines of a page as one sentence: a word the line broke with a hyphen ("po-" / "stępowaniu") is joined back.
const joinLine = (before: string, after: string): string => {
    if (before === "") {
        return after;
    }
    if (/\p{L}-$/u.test(before) && /^\p{Ll}/u.test(after)) {
        return `${before.slice(0, -1)}${after}`;
    }
    return `${before} ${after}`;
};

const unitToken = (token: string): string =>
    token
        .replace(/^(?:par\.?|§)$/iu, "§")
        .replace(/^ust\.?$/iu, "ust.")
        .replace(/^pkt\.?$/iu, "pkt")
        .replace(/^lit\.?$/iu, "lit.");

// An address an agent typed, "35 § 1", "31 ust. 2 pkt 3", "§ 4 ust. 1", "22[1] § 2", split into the article key and the
// rest of the marker ("§ 1", "ust. 2 pkt 3").
export interface Address {
    readonly article: string;
    readonly rest: string;
}
export const parseAddress = (raw: string): Address => {
    // "zał. 1 § 5", "załącznik nr 1 § 5": a provision of an annex, keyed "z1:5".
    const annex = /^zał(?:ącznik)?\.?\s*(?:nr\s*)?(\d+[a-z]?)\s*,?\s*/iu.exec(raw.trim());
    if (annex !== null) {
        const inner = parseAddress(raw.trim().slice(annex[0].length));
        return { article: `z${(annex[1] ?? "").toLowerCase()}:${inner.article}`, rest: inner.rest };
    }
    const spaced = raw
        .trim()
        .replace(/^(?:art\.?|§)\s*/iu, "")
        .replace(/§\s*/gu, "§ ")
        .replace(/\b(ust|pkt|lit|par)\.?\s*/giu, "$1 ");
    const [first = "", ...tail] = spaced.split(/\s+/u);
    const rest: string[] = [];
    for (let index = 0; index < tail.length; index += 2) {
        const kind = unitToken(tail[index] ?? "");
        const value = (tail[index + 1] ?? "").replace(/[.)]$/u, "").toLowerCase();
        if (!["§", "ust.", "pkt", "lit."].includes(kind) || value === "") {
            throw new Error(`cannot read "${raw}" as an article address: write it like "35 § 1", "31 ust. 2 pkt 3" or "22[1]"`);
        }
        rest.push(`${kind} ${value}`);
    }
    return { article: articleKey(first), rest: rest.join(" ") };
};

export const findArticle = (text: ParsedText, key: string): Article | undefined => text.articles.find((article) => article.number === key);

const within = (marker: string, outer: string): boolean => marker === outer || marker.startsWith(`${outer} `);

// The notes that speak about a selection: those on the article as a whole, on the selection or a unit inside it, and on
// a unit the selection sits in (a note on "ust. 2" covers its "pkt 8").
export const notesFor = (article: Article, rest: string): Note[] => {
    if (rest === "") {
        return article.notes;
    }
    const selected = `${article.marker} ${rest}`;
    return article.notes.filter((note) => note.marker === article.marker || within(note.marker, selected) || within(selected, note.marker));
};

// The units an address points at, its subdivisions included: "Art. 35 § 1" answers § 1 and the points under it.
export const selectUnits = (article: Article, rest: string): Unit[] => {
    if (rest === "") {
        return article.units;
    }
    const marker = `${article.marker} ${rest}`;
    return article.units.filter((unit) => within(unit.marker, marker));
};
