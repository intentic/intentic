// A written reply made into something to say. A coding agent's reply is markdown full of things no voice should spell
// out: fenced code, tables, file paths with line numbers, URLs, inline identifiers. Read aloud whole (`read`), each of
// those is announced or shortened; turned into a short answer (`reply`), only its opening words and its closing
// question survive (spokenFallback, used when no model is set for the `spoken-reply` job). Either way the result is cut
// into sentences, the unit a local voice speaks one at a time.

// The few words announcements need, in the languages there are voices for; any other is announced in English.
interface Phrases {
    readonly code: (lines: number) => string;
    readonly table: (rows: number) => string;
    readonly image: string;
}

const PHRASES = {
    en: { code: (n) => `Code, ${n} ${n === 1 ? "line" : "lines"}.`, table: (n) => `A table of ${n} ${n === 1 ? "row" : "rows"}.`, image: "An image." },
    pl: {
        code: (n) => `Kod, ${n} ${n === 1 ? "linia" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "linie" : "linii"}.`,
        table: (n) => `Tabela, ${n} ${n === 1 ? "wiersz" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "wiersze" : "wierszy"}.`,
        image: "Obraz.",
    },
    de: { code: (n) => `Code, ${n} ${n === 1 ? "Zeile" : "Zeilen"}.`, table: (n) => `Eine Tabelle mit ${n} ${n === 1 ? "Zeile" : "Zeilen"}.`, image: "Ein Bild." },
    es: { code: (n) => `Código, ${n} ${n === 1 ? "línea" : "líneas"}.`, table: (n) => `Una tabla de ${n} ${n === 1 ? "fila" : "filas"}.`, image: "Una imagen." },
    fr: { code: (n) => `Du code, ${n} ${n === 1 ? "ligne" : "lignes"}.`, table: (n) => `Un tableau de ${n} ${n === 1 ? "ligne" : "lignes"}.`, image: "Une image." },
    it: { code: (n) => `Codice, ${n} ${n === 1 ? "riga" : "righe"}.`, table: (n) => `Una tabella di ${n} ${n === 1 ? "riga" : "righe"}.`, image: "Un'immagine." },
    pt: { code: (n) => `Código, ${n} ${n === 1 ? "linha" : "linhas"}.`, table: (n) => `Uma tabela de ${n} ${n === 1 ? "linha" : "linhas"}.`, image: "Uma imagem." },
} satisfies Record<string, Phrases>;

const phrasesFor = (language: string): Phrases =>
    // SAFETY: `in` has just checked that the language is one of PHRASES' own keys.
    language in PHRASES ? PHRASES[language as keyof typeof PHRASES] : PHRASES.en;

// A path or a file reference as a person would say it: its last name, without a line number (`src/a/b.ts:12` → `b.ts`).
const PATH = /(?:[\w@.-]+\/)+([\w@.-]+)(?::\d+(?::\d+)?)?/gu;
const URL = /\bhttps?:\/\/([^/\s)]+)[^\s)]*/gu;

// Inline markdown to its words: links and images to their text, emphasis and code ticks dropped, paths and URLs said
// short, and glyphs a voice would read as noise (arrows, bullets) made into pauses.
export const speakableInline = (line: string): string =>
    line
        .replaceAll(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
        .replaceAll(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
        .replaceAll(/<[^>]+>/gu, "")
        .replaceAll(URL, "$1")
        .replaceAll(/`([^`]*)`/gu, "$1")
        .replaceAll(PATH, "$1")
        .replaceAll(/(\*\*|__|~~)/gu, "")
        .replaceAll(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|[.,;:!?]|$)/gu, "$1$2")
        .replaceAll(/\s*(?:->|→|⟶|=>|·|•|—|–)\s*/gu, ", ")
        .replaceAll(/\p{Extended_Pictographic}️?/gu, "")
        .replaceAll(/\s+/gu, " ")
        .trim();

const FENCE = /^\s{0,3}(```|~~~)/u;
const TABLE_ROW = /^\s*\|.*\|\s*$/u;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}/u;
const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u;
const HEADING = /^\s{0,3}#{1,6}\s+/u;
const QUOTE = /^\s{0,3}>\s?/u;

// A sentence ends a line it did not end itself, so a heading or a list item is its own sentence when spoken.
const closed = (text: string): string => (text === "" || /[.!?…:;]$/u.test(text) ? text : `${text}.`);

const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/u;

// A fence runs to its closing fence (or the end, unclosed); a table to its last row.
const fenceEnd = (lines: readonly string[], index: number): number => {
    let end = index + 1;
    while (end < lines.length && !FENCE.test(lines[end]!)) {
        end += 1;
    }
    return end;
};
const tableEnd = (lines: readonly string[], index: number): number => {
    let end = index;
    while (end + 1 < lines.length && TABLE_ROW.test(lines[end + 1]!)) {
        end += 1;
    }
    return end;
};

// What one line, or the block starting at it, says: a sentence of its own (`whole`: an announcement, a heading, a list
// item), a line of running prose, or nothing (a blank line or a rule, which ends the paragraph before it).
interface Unit {
    readonly text: string;
    readonly whole: boolean;
}
// A unit and the index of the line after it.
interface UnitRead {
    readonly unit: Unit | undefined;
    readonly next: number;
}

const unitAt = (lines: readonly string[], index: number, phrases: Phrases): UnitRead => {
    const line = lines[index]!;
    if (FENCE.test(line)) {
        const end = fenceEnd(lines, index);
        return { unit: { text: phrases.code(Math.max(1, end - index - 1)), whole: true }, next: end + 1 };
    }
    if (TABLE_ROW.test(line)) {
        const end = tableEnd(lines, index);
        const rows = lines.slice(index, end + 1).filter((row) => !TABLE_RULE.test(row)).length - 1;
        return { unit: { text: phrases.table(Math.max(1, rows)), whole: true }, next: end + 1 };
    }
    const words = RULE.test(line) ? "" : speakableInline(line.replace(HEADING, "").replace(QUOTE, "").replace(LIST_MARK, ""));
    if (words === "") {
        const image = line.trim().startsWith("![");
        return { unit: image ? { text: phrases.image, whole: true } : undefined, next: index + 1 };
    }
    return { unit: { text: words, whole: HEADING.test(line) || LIST_MARK.test(line) }, next: index + 1 };
};

/** A written reply as words to read aloud whole, in its language: code and tables announced, never spelled out. */
export const speakableMarkdown = (markdown: string, language: string): string => {
    const phrases = phrasesFor(language);
    const lines = markdown.split(/\r?\n/u);
    const spoken: string[] = [];
    let paragraph: string[] = [];
    const flush = (): void => {
        if (paragraph.length > 0) {
            spoken.push(closed(paragraph.join(" ")));
            paragraph = [];
        }
    };
    for (let index = 0; index < lines.length; ) {
        const { unit, next } = unitAt(lines, index, phrases);
        index = next;
        if (unit === undefined || unit.whole) {
            flush();
        }
        if (unit?.whole === true) {
            spoken.push(closed(unit.text));
        } else if (unit !== undefined) {
            paragraph.push(unit.text);
        }
    }
    flush();
    return spoken.join(" ");
};

// How long a sentence may run before it is cut at a comma: a local voice speaks one sentence before the next is made,
// so a very long one is a long silence before anything is heard.
const LONGEST = 220;

const cutLong = (sentence: string): string[] => {
    if (sentence.length <= LONGEST) {
        return [sentence];
    }
    const parts: string[] = [];
    let rest = sentence;
    while (rest.length > LONGEST) {
        const window = rest.slice(0, LONGEST);
        const at = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
        const cut = at > LONGEST / 3 ? at + 1 : (window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : LONGEST);
        parts.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest !== "") {
        parts.push(rest);
    }
    return parts;
};

// Ends of sentences: terminal punctuation followed by a space and a capital or a digit, or a line break. "e.g. the"
// and "v1.2.3" stay whole, since neither is followed by a capital.
const SENTENCE_END = /(?<=[.!?…])\s+(?=[\p{Lu}\d"„«(])|\n+/u;

/** Text cut into the sentences a voice says one at a time; a short one rides with the next. */
export const sentencesOf = (text: string): string[] => {
    const raw = text
        .split(SENTENCE_END)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence !== "");
    const merged: string[] = [];
    for (const sentence of raw) {
        const last = merged.at(-1);
        if (last !== undefined && last.length < 24) {
            merged[merged.length - 1] = `${last} ${sentence}`;
        } else {
            merged.push(sentence);
        }
    }
    return merged.flatMap(cutLong);
};

// The words a short answer keeps when no model wrote one: the reply's opening sentences up to WORDS_KEPT words, and
// its closing question when it asks one, since that is what the person has to answer.
const WORDS_KEPT = 45;

const wordCount = (text: string): number => text.split(/\s+/u).filter((word) => word !== "").length;

/** A reply as a few spoken sentences, without a model: how it opens, and what it asks. */
export const spokenFallback = (markdown: string, language: string): string => {
    // Code and tables are what a listener can least use: dropped here, not announced.
    const prose = markdown
        .replaceAll(/^\s{0,3}(```|~~~)[\s\S]*?^\s{0,3}\1\s*$/gmu, "")
        .split(/\r?\n/u)
        // Headings name parts of a page the listener cannot see, and a list's items are its detail.
        .filter((line) => !TABLE_ROW.test(line) && !HEADING.test(line) && !LIST_MARK.test(line))
        .join("\n");
    const sentences = sentencesOf(speakableMarkdown(prose, language));
    const kept: string[] = [];
    let words = 0;
    for (const sentence of sentences) {
        const more = wordCount(sentence);
        if (kept.length > 0 && words + more > WORDS_KEPT) {
            break;
        }
        kept.push(sentence);
        words += more;
    }
    const question = sentences.findLast((sentence) => sentence.endsWith("?"));
    if (question !== undefined && !kept.includes(question)) {
        kept.push(question);
    }
    return kept.join(" ");
};
