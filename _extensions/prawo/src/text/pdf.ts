import { ArticleBuilder, type Article, articleKey, articleMarker, follows, type Level, type ParsedText, type TopUnit, type Unit } from "./model.js";

/* A PDF OF AN ACT, AS `fileq read --plain` GIVES ITS TEXT LAYER, BACK INTO ARTICLES. The layer is lines in reading
   order with `## Page N` between pages, and it keeps everything printed on the page: running heads ("Dziennik Ustaw –
   9 – Poz. 1691"), footnotes at the foot ("3) Dodany przez art. 1 pkt 1 ustawy…"), their markers glued to the word
   they annotate ("Art. 45a.3)"), and, in a unified text, the margin notes ("Nowe brzmienie … wejdzie w życie …"). Each
   is taken out and kept as a note of the article it belongs to, so the wording quoted is the act's alone. Numbers
   printed raised lose that in the layer: "Art. 39¹" reads "Art. 391", or "Art. 22[1]" in some acts. */

interface Line {
    readonly text: string;
    // Footnotes whose markers this line carried.
    readonly refs: readonly number[];
    // A margin note standing where the line would be.
    readonly note?: string | undefined;
}

type Entry = { readonly kind: "line"; readonly text: string } | { readonly kind: "note"; readonly note: string };

const RUNNING_HEAD = [
    // "Dziennik Ustaw – 9 – Poz. 1691", and before 2012 "Dziennik Ustaw Nr 14 — 747 — Poz. 67".
    /^(?:Dziennik Ustaw|Monitor Polski)(?:\s+Nr\s+\d+)?\s+[–—-]\s+\d+\s+[–—-]\s+Poz\.\s+\d+$/u,
    /^©\s*Kancelaria Sejmu\s+s\.\s+\d+\/\d+$/u,
];

// A footnote marker glued to what it annotates: "zm.1))", "Art. 45a.3)", "8)12)", "3.13)". A list point always stands
// after a line break or a space, so a number glued to a letter or a stop is a marker.
const GLUED_REF = /(?<=[\p{L}.,;:)”’])(\d{1,3})\)(?=[\s,.;:)]|$)/gu;

// The start of a subdivision or a heading, which a margin note never is.
const STRUCTURAL = /^(?:Art\.\s*\d|§\s*\d|\d+[a-z]*[.)]\s|[a-z]{1,2}\)\s|[–-]\s)/u;
const FOOTNOTE_START = /^(\d{1,3})\)\s+(.*)$/u;
const BROKEN_WORD = /\p{L}-$/u;

const glue = (before: string, after: string): string => (BROKEN_WORD.test(before) ? before.slice(0, -1) + after : `${before} ${after}`.trim());

// Page by page, without what the converter printed before the first page (a PDF library's warnings).
const pagesOf = (markdown: string): Entry[][] =>
    markdown
        .split(/^## Page \d+\s*$/mu)
        .slice(/^## Page \d+\s*$/mu.test(markdown) ? 1 : 0)
        .map((page) =>
            page
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line !== "" && !RUNNING_HEAD.some((head) => head.test(line)))
                .map((text): Entry => ({ kind: "line", text })),
        )
        .filter((lines) => lines.length > 0);

// A unified text prints notes in the margin, which the layer gives as a run of very short lines among the body's long
// ones ("Opracowano na" / "podstawie: t.j." / "Dz. U. z 2025 r." …). Three or more in a row, none opening a
// subdivision or a heading, are one note.
const MARGIN_LINE = 24;
const textOf = (entry: Entry | undefined): string | undefined => (entry?.kind === "line" ? entry.text : undefined);
const isMarginLine = (entry: Entry | undefined): boolean => {
    const line = textOf(entry);
    return line !== undefined && line.length <= MARGIN_LINE && !STRUCTURAL.test(line) && !HEADING.test(line);
};
const marginNotes = (entries: readonly Entry[]): Entry[] => {
    const out: Entry[] = [];
    let index = 0;
    while (index < entries.length) {
        let end = index;
        // A note opens with a capital ("Nowe brzmienie…", "Opracowano na…"); a short line that does not is the tail
        // of a footnote or a sentence.
        while (isMarginLine(entries[end]) && (end > index || /^\p{Lu}/u.test(textOf(entries[end]) ?? ""))) {
            end += 1;
        }
        if (end - index >= 3) {
            out.push({ kind: "note", note: entries.slice(index, end).map((entry) => textOf(entry) ?? "").reduce(glue) });
            index = end;
        } else {
            out.push(entries[index] ?? { kind: "line", text: "" });
            index += 1;
        }
    }
    return out;
};

const gluedRefs = (text: string): number[] => [...text.matchAll(GLUED_REF)].map((match) => Number(match[1]));

// The footnotes from `start` to the foot, or undefined when a numbered line breaks the sequence (a list point).
const footnotesFrom = (entries: readonly Entry[], start: number, first: number, waiting: readonly number[]): Map<number, string> | undefined => {
    const notes = new Map<number, string>();
    let expected = first;
    for (const entry of entries.slice(start)) {
        if (entry.kind === "note") {
            continue;
        }
        const numbered = FOOTNOTE_START.exec(entry.text);
        if (numbered === null) {
            notes.set(expected - 1, glue(notes.get(expected - 1) ?? "", entry.text));
            continue;
        }
        if (Number(numbered[1]) !== expected || !waiting.includes(expected)) {
            return undefined;
        }
        notes.set(expected, numbered[2] ?? "");
        expected += 1;
    }
    return notes;
};

// The footnotes at a page's foot. A block starts after the last line carrying a marker, with a footnote still waiting
// for its text, at a capital letter (a footnote is a sentence: "Dodany przez…", "Zmiany tekstu jednolitego…"); every
// numbered line from there to the foot must continue the sequence. A list point that happens to carry the right
// number ("1) (uchylony)") fails one of those, and stays in the body.
interface FootBlock {
    readonly start: number;
    readonly notes: Map<number, string>;
}
const footBlock = (entries: readonly Entry[], waiting: readonly number[]): FootBlock | undefined => {
    const lastRef = entries.findLastIndex((entry) => gluedRefs(textOf(entry) ?? "").length > 0);
    for (let start = lastRef + 1; start < entries.length; start += 1) {
        const head = FOOTNOTE_START.exec(textOf(entries[start]) ?? "");
        const first = Number(head?.[1]);
        if (head !== null && waiting.includes(first) && /^\p{Lu}/u.test(head[2] ?? "")) {
            const notes = footnotesFrom(entries, start, first, waiting);
            if (notes !== undefined) {
                return { start, notes };
            }
        }
    }
    return undefined;
};

// Every page's lines with running heads, footnotes and margin notes taken out, and the footnotes' text by number.
interface Cleaned {
    readonly lines: Line[];
    readonly footnotes: Map<number, string>;
}
const cleanPages = (markdown: string, unified: boolean): Cleaned => {
    const footnotes = new Map<number, string>();
    const lines: Line[] = [];
    let waiting: number[] = [];
    for (const page of pagesOf(markdown)) {
        const entries = unified ? marginNotes(page) : page;
        const fresh = entries.flatMap((entry) => gluedRefs(textOf(entry) ?? ""));
        waiting = [...new Set([...waiting, ...fresh])].filter((ref) => !footnotes.has(ref)).toSorted((a, b) => a - b);
        const block = footBlock(entries, waiting);
        for (const [ref, note] of block?.notes ?? []) {
            footnotes.set(ref, note.trim());
        }
        // Footnotes are numbered in order, so a marker older than the last one found never gets its text.
        const found = Math.max(0, ...(block?.notes.keys() ?? []));
        waiting = waiting.filter((ref) => !footnotes.has(ref) && ref > found);
        entries.forEach((entry, index) => {
            if (entry.kind === "note") {
                lines.push({ text: "", refs: [], note: entry.note });
            } else if (block === undefined || index < block.start) {
                lines.push({ text: entry.text.replace(GLUED_REF, ""), refs: gluedRefs(entry.text) });
            }
        });
    }
    return { lines, footnotes };
};

// "DZIAŁ IVA", "Rozdział 2a", and the codes' ordinal words: "DZIAŁ TRZYNASTY".
const HEADING = /^(?:DZIAŁ|Dział|ROZDZIAŁ|Rozdział|ODDZIAŁ|Oddział|TYTUŁ|Tytuł|KSIĘGA|Księga|CZĘŚĆ|Część)\s+(?:[IVXLCDM]+[A-Za-z]{0,2}|\d+[A-Za-z]{0,2}|[A-ZĄĆĘŁŃÓŚŹŻ]{4,})$/u;
const HEADING_RANKS = ["księga", "część", "tytuł", "dział", "rozdział", "oddział"];
const ANNEX_START = /^Załącznik do obwieszczenia/u;
const BASIS = /^Opracowano na podstawie/u;
const CITED_ACT_CHANGES = /^Zmian[ay]\b.*\bwymienion/u;
// An annex of the act ("Załącznik nr 1", "Załącznik nr 2 do rozporządzenia …"), or the heading over all of them. A
// sentence that wraps onto "załącznik nr 3 do rozporządzenia;" is lower case or ends mid-sentence, and is no heading.
const ANNEX = /^Załącznik(i)?(?:\s+nr\s+(\d+[a-z]?))?(?:\s+do\s+(.*[^;,:]))?$/u;
// An annex of an annex, a form or a template: no provisions to quote in it.
const SUB_ANNEX = /^(?:instrukcji|załącznika|wzoru|regulaminu|statutu)\b/iu;
const ARTICLE = /^Art\.\s*(\d+)(?:\[([0-9a-z]+)\])?([a-z]{0,4})(?:\s*[–-]\s*(\d+)(?:\[[0-9a-z]+\])?[a-z]{0,4})?\.\s*(.*)$/u;
const PARAGRAPH = /^§\s*(\d+[a-z]{0,4})\.\s*(.*)$/u;

const baseOf = (key: string | undefined): string | undefined => (key === undefined ? undefined : /^(\d+)/u.exec(key.split("-").at(-1) ?? "")?.[1]);

// An article's place in the act: its number, then the raised part, then the letters ("39" < "39^1" < "39^2" < "40").
const placeOf = (key: string): readonly [number, string, string] => {
    const match = /^(\d+)(?:\^([0-9a-z]+))?([a-z]*)$/u.exec(key.split("-").at(-1) ?? key);
    return [Number(match?.[1]), match?.[2] ?? "", match?.[3] ?? ""];
};
// Whether `next` may follow `previous`. Equal is allowed: a consolidated text prints both versions of a provision whose
// new wording takes effect later, each with a footnote saying which is which.
const inOrder = (next: string, previous: string | undefined): boolean => {
    if (previous === undefined) {
        return true;
    }
    const [nextBase, nextRaised, nextLetters] = placeOf(next);
    const [previousBase, previousRaised, previousLetters] = placeOf(previous);
    if (nextBase !== previousBase) {
        return nextBase > previousBase;
    }
    const raised = nextRaised.localeCompare(previousRaised, "en", { numeric: true });
    return raised === 0 ? nextLetters >= previousLetters : raised > 0;
};

// Whether `base` could be `previousBase` with a raised number glued on ("391" after "39").
const raisedTail = (base: string, previousBase: string): string | undefined => {
    const tail = base.slice(previousBase.length);
    return base.startsWith(previousBase) && /^[1-9]\d?$/u.test(tail) ? tail : undefined;
};

// An article heading's number, or undefined for a line that only looks like one (a quoted provision, a number out of
// sequence). A raised number the layer flattened is read back as raised: "391" after "39" is "39^1" when the next
// heading outside that family ("40") would otherwise run backwards. A plain jump ("35" after "3", across repealed
// articles the text omits) keeps its number, since what follows it ("40") still runs forward.
const articleNumber = (match: RegExpExecArray, previous: string | undefined, nextOutside: (family: string) => number | undefined): string | undefined => {
    const [, base = "", raised, letters = "", rangeEnd] = match;
    const previousBase = baseOf(previous);
    const tail = previousBase === undefined || raised !== undefined || letters !== "" || rangeEnd !== undefined ? undefined : raisedTail(base, previousBase);
    const following = tail === undefined || previousBase === undefined ? undefined : nextOutside(previousBase);
    const key =
        rangeEnd !== undefined
            ? `${base}-${rangeEnd}`
            : following !== undefined && following < Number(base)
              ? `${previousBase ?? ""}^${tail ?? ""}`
              : `${base}${raised === undefined ? "" : `^${raised}`}${letters}`;
    return inOrder(key.split("-")[0] ?? key, previous) ? key : undefined;
};

// Where a new subdivision may start: after a line that ends a sentence or an item ("…;", "… albo"), never inside a
// wrapped sentence.
const closes = (previous: string): boolean => /(?:[.:;,)–]|\s(?:albo|lub|oraz|i|bądź|a także))$/u.test(previous);

interface Rule {
    readonly level: Level;
    readonly pattern: RegExp;
    readonly label: (value: string) => string;
    readonly accepts: (builder: ArticleBuilder, value: string, previous: string) => boolean;
}

const RULES: readonly Rule[] = [
    { level: "par", pattern: PARAGRAPH, label: (value) => `§ ${value}.`, accepts: (builder, value) => follows(value, builder.current("par")) },
    {
        level: "ust",
        pattern: /^(\d+[a-z]{0,4})\.\s+(.*)$/u,
        label: (value) => `${value}.`,
        accepts: (builder, value, previous) => closes(previous) && follows(value, builder.current("ust")),
    },
    {
        level: "pkt",
        pattern: /^(\d+[a-z]{0,4})\)\s*(.*)$/u,
        label: (value) => `${value})`,
        accepts: (builder, value, previous) => closes(previous) && follows(value, builder.current("pkt")),
    },
    {
        level: "lit",
        pattern: /^([a-z]{1,2})\)\s+(.*)$/u,
        label: (value) => `${value})`,
        accepts: (builder, value, previous) => closes(previous) && builder.current("pkt") !== undefined && follows(value, builder.current("lit")),
    },
    { level: "tiret", pattern: /^([–-])\s+(.*)$/u, label: () => "–", accepts: (_, __, previous) => /[:;]$/u.test(previous) },
];

// A new subdivision the line opens, if it opens one. In a regulation the paragraph is the article itself, so a "§" line
// that did not open the next one is wording.
const subdivide = (builder: ArticleBuilder, text: string, previous: string, top: TopUnit): boolean => {
    for (const rule of RULES.filter((candidate) => top === "art" || candidate.level !== "par")) {
        const match = rule.pattern.exec(text);
        const value = rule.level === "tiret" ? "" : (match?.[1] ?? "");
        if (match !== null && rule.accepts(builder, value, previous)) {
            builder.write(builder.open(rule.level, value, rule.label(value)), match[2] ?? "");
            return true;
        }
    }
    return false;
};

interface Start {
    readonly key: string;
    readonly rest: string;
}

// Walks a part's lines once, opening an article at each heading in sequence and a heading context at each "Dział",
// "Rozdział" and the like, whose title is the lines up to the next article.
class Assembler {
    readonly articles: Article[] = [];
    private readonly headings: { key: string; text: string }[] = [];
    private builder: ArticleBuilder | undefined;
    private collecting: { readonly key: string; readonly parts: string[] } | undefined;
    private previous = "";

    private index = 0;

    constructor(
        private readonly top: TopUnit,
        private readonly footnotes: ReadonlyMap<number, string>,
        // The number on each line that looks like an article heading, by line: what comes next, for a flattened one.
        private readonly bases: readonly (string | undefined)[],
        // In an annex, its number: "§ 5" there is "Załącznik nr 1 § 5", keyed "z1:5".
        private readonly annex?: string | undefined,
    ) {}

    feed(line: Line, index: number): void {
        this.index = index;
        if (line.note !== undefined) {
            if (!BASIS.test(line.note)) {
                this.builder?.note(line.note, true);
            }
            return;
        }
        const started = this.start(line.text);
        if (HEADING.test(line.text)) {
            this.finish();
            this.collecting = { key: line.text.split(/\s+/u)[0]?.toLowerCase() ?? "", parts: [line.text] };
        } else if (started !== undefined) {
            this.open(started, line);
        } else if (this.collecting !== undefined) {
            this.collecting.parts.push(line.text);
        } else if (this.builder !== undefined) {
            if (!subdivide(this.builder, line.text, this.previous, this.top)) {
                this.builder.continue(line.text);
            }
            for (const note of this.notesOf(line.refs)) {
                this.builder.note(note);
            }
        }
        this.previous = line.text;
    }

    finish(): void {
        if (this.builder !== undefined) {
            this.articles.push(this.builder.build());
        }
        this.builder = undefined;
        if (this.collecting !== undefined) {
            const rank = HEADING_RANKS.indexOf(this.collecting.key);
            const outer = this.headings.filter((heading) => HEADING_RANKS.indexOf(heading.key) < rank);
            this.headings.splice(0, this.headings.length, ...outer, { key: this.collecting.key, text: this.collecting.parts.join(" — ") });
            this.collecting = undefined;
        }
    }

    private open(started: Start, line: Line): void {
        this.finish();
        const heading = this.headings.map((entry) => entry.text).join(" / ");
        const key = this.annex === undefined ? started.key : `z${this.annex}:${started.key}`;
        const marker = `${this.annex === undefined ? "" : `Załącznik nr ${this.annex} `}${articleMarker(this.top, started.key)}`;
        this.builder = new ArticleBuilder(key, marker, heading === "" ? undefined : heading);
        // A marker on a heading line stands right after the article's number ("Art. 45a.3)"): it is about the article.
        for (const note of this.notesOf(line.refs)) {
            this.builder.note(note, true);
        }
        if (started.rest !== "" && !subdivide(this.builder, started.rest, ".", this.top)) {
            this.builder.write(undefined, started.rest);
        }
    }

    private start(text: string): Start | undefined {
        const last = (this.builder?.number ?? this.articles.at(-1)?.number)?.replace(/^z[^:]*:/u, "");
        if (this.top === "par") {
            const match = PARAGRAPH.exec(text);
            return match !== null && follows(match[1] ?? "", last) ? { key: match[1] ?? "", rest: match[2] ?? "" } : undefined;
        }
        const match = ARTICLE.exec(text);
        const key = match === null ? undefined : articleNumber(match, last, (family) => this.nextOutside(family));
        return match === null || key === undefined ? undefined : { key: articleKey(key), rest: match[5] ?? "" };
    }

    // The number of the next article heading after this line that is not `family` with a raised number glued on.
    private nextOutside(family: string): number | undefined {
        const next = this.bases.slice(this.index + 1).find((base) => base !== undefined && raisedTail(base, family) === undefined);
        return next === undefined ? undefined : Number(next);
    }

    // The footnotes about this provision: who added or changed it, and when. Those listing a cited act's own amendments
    // ("Zmiany tekstu jednolitego wymienionej ustawy zostały ogłoszone…") say nothing about it, and are left out.
    private notesOf(refs: readonly number[]): string[] {
        return refs.flatMap((ref) => {
            const note = this.footnotes.get(ref);
            return note === undefined || CITED_ACT_CHANGES.test(note) ? [] : [`${String(ref)}) ${note}`];
        });
    }
}

// The basic unit of a part: articles in a statute, paragraphs in a regulation or an instruction it annexes, nothing to
// quote in an annex that is a table or a form.
const topUnitOf = (lines: readonly Line[]): TopUnit | undefined => {
    if (lines.some((line) => ARTICLE.test(line.text))) {
        return "art";
    }
    return lines.some((line) => PARAGRAPH.test(line.text)) ? "par" : undefined;
};

interface Part {
    readonly annex?: string | undefined;
    readonly lines: Line[];
}

const FIRST_PROVISION = /^(?:Art\.|§)\s*1\.\s/u;

// The act's own text, then each annex the act numbers ("Załącznik nr 1"). An annex's own annexes (forms, templates)
// end it once its provisions have begun; before that the line is its table of contents naming them.
const partsOf = (body: readonly Line[]): Part[] => {
    const parts: Part[] = [{ lines: [] }];
    let skipping = false;
    for (const line of body) {
        const annex = ANNEX.exec(line.text);
        if (annex !== null) {
            const begun = parts.at(-1)?.lines.some((entry) => FIRST_PROVISION.test(entry.text)) === true;
            const sub = annex[1] === undefined && SUB_ANNEX.test(annex[3] ?? "");
            skipping = sub ? begun || skipping : false;
            if (annex[1] === undefined && !sub) {
                parts.push({ annex: annex[2] ?? "1", lines: [] });
            }
            continue;
        }
        if (!skipping) {
            parts.at(-1)?.lines.push(line);
        }
    }
    return parts;
};

const tidy = (article: Article): Article => ({
    ...article,
    units: article.units.map((unit): Unit => ({ ...unit, text: unit.text.replaceAll(/\s+/gu, " ").trim() })),
});

export const articlesFromPdfText = (markdown: string, options: { readonly unified?: boolean } = {}): ParsedText => {
    const { lines, footnotes } = cleanPages(markdown, options.unified === true);
    const annex = lines.findIndex((line) => ANNEX_START.test(line.text));
    const body = annex >= 0 ? lines.slice(annex + 1) : lines;
    const articles = partsOf(body).flatMap((part) => {
        const top = topUnitOf(part.lines);
        if (top === undefined) {
            return [];
        }
        const assembler = new Assembler(
            top,
            footnotes,
            part.lines.map((line) => ARTICLE.exec(line.text)?.[1]),
            part.annex,
        );
        part.lines.forEach((line, index) => assembler.feed(line, index));
        assembler.finish();
        return assembler.articles;
    });
    const notice = annex >= 0 ? lines.slice(0, annex).map((line) => line.text).join(" ").replaceAll(/\s+/gu, " ").trim() : undefined;
    const basis = lines.find((line) => line.note !== undefined && BASIS.test(line.note))?.note;
    return { articles: articles.map(tidy), notice, basis };
};
