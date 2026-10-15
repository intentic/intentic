import { ArticleBuilder, type Article, articleKey, articleMarker, type Level, type ParsedText, superscript, type TopUnit, type Unit } from "./model.js";

/* AN ACT'S HTML FROM THE SEJM'S ELI API, BACK INTO ARTICLES. The page nests one `<div class="unit unit_<kind>">` per
   division of the act (bran, chpt, arti, para, pass, pint, lett, tire), each with an `<h3>` label ("Art. 35.", "§ 1.",
   "2.", "3)") and its wording in `<div data-template="xText">` blocks. The nesting is the structure, so the reader
   tracks it with a stack of open divs rather than guessing from line shapes as the PDF reader must. A consolidated
   text's page holds two parts: the announcement, which quotes articles of the amending act, and the annex with the
   text itself; only the annex is read. Footnotes sit in tooltips beside their marker and are lifted out. */

const ENTITIES: ReadonlyMap<string, string> = new Map([
    ["nbsp", " "],
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", '"'],
    ["apos", "'"],
]);

const decode = (value: string): string =>
    value.replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (whole, entity: string) => {
        if (entity.startsWith("#x") || entity.startsWith("#X")) {
            return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
        }
        if (entity.startsWith("#")) {
            return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
        }
        return ENTITIES.get(entity.toLowerCase()) ?? whole;
    });

// Text without markup: a block element ends a word, an inline one (a link, a hidden span) does not, so a citation
// wrapped in a link reads "(Dz. U. z 2019 r. poz. 1461)" rather than "( Dz. U. … )".
const clean = (value: string): string =>
    decode(value.replaceAll(/<\/?(?:p|div|br|h\d|li|ul|ol|table|tr|td)\b[^>]*>/giu, " ").replaceAll(/<[^>]*>/gu, ""))
        .replaceAll(/\s+/gu, " ")
        .replaceAll(/\(\s+/gu, "(")
        .replaceAll(/\s+([),.;:])/gu, "$1")
        .trim();

// A document's paragraphs as lines of plain text: a ruling's HTML for reading.
export const htmlLines = (html: string): string[] =>
    html
        .split(/<\/(?:p|div|h\d|li|tr)>|<br\s*\/?>/iu)
        .map(clean)
        .filter((line) => line !== "");

// A heading's lines, "Rozdział 7" and "Doręczenia", as one: "Rozdział 7 — Doręczenia".
const headingText = (value: string): string =>
    value
        .split(/<\/p>/iu)
        .map(clean)
        .filter((line) => line !== "")
        .join(" — ");

// A footnote's marker and tooltip, `<a class="gloss-link tooltip"><sup>3)</sup><span class="tooltip-text">…</span></a>`,
// becomes a placeholder the text keeps until it is read, and the tooltip's words a note.
const FOOTNOTE = /<a\b[^>]*gloss-link[^>]*>\s*<sup>\s*(\d+)\)\s*<\/sup>\s*<span[^>]*tooltip-text[^>]*>([\s\S]*?)<\/span>\s*<\/span>\s*<\/a>/giu;
const PLACEHOLDER = /\u0001(\d+)\u0001/gu;

const liftFootnotes = (html: string, footnotes: Map<number, string>): string =>
    html.replaceAll(FOOTNOTE, (_, ref: string, note: string) => {
        footnotes.set(Number(ref), clean(note));
        return `\u0001${ref}\u0001`;
    });

// The part of the page that is the act's text: a consolidated text's annex, else the act's own first part.
interface TextPart {
    readonly body: string;
    readonly notice?: string | undefined;
}
const textPart = (html: string): TextPart => {
    const sections = [...html.matchAll(/<section\b[^>]*id="part_\d+"[^>]*>([\s\S]*?)<\/section>/giu)].map((match) => match[1] ?? "");
    const annex = sections.findIndex((section) => /<h2\b[^>]*>[\s\S]*?Tekst jednolity[\s\S]*?<\/h2>/iu.test(section));
    if (annex >= 0) {
        const notice = sections.slice(0, annex).map(clean).join(" ").replace(/^Treść obwieszczenia\s*/u, "");
        return { body: sections[annex] ?? "", notice: notice === "" ? undefined : notice };
    }
    return { body: sections[0] ?? html };
};

const LEVEL_OF: ReadonlyMap<string, Level> = new Map([
    ["para", "par"],
    ["pass", "ust"],
    ["pint", "pkt"],
    ["lett", "lit"],
    ["tire", "tiret"],
]);
const HEADINGS = new Set(["book", "part", "titl", "bran", "chpt", "schp"]);

interface Frame {
    readonly tag: "div" | "h3";
    // The act's division this div opens ("arti", "para", "chpt"…), absent for a layout div.
    readonly kind?: string | undefined;
    // A div holding wording, or the h3 holding a division's label.
    readonly collects: boolean;
    text: string;
    // What the division became once its label was read.
    unit?: Unit | undefined;
    heading?: string | undefined;
}

// Walks the page's divs and h3s in order, keeping the stack of open ones, and hands each label and each piece of
// wording to the article it belongs to.
class Reader {
    readonly articles: Article[] = [];
    private readonly stack: Frame[] = [];
    private builder: ArticleBuilder | undefined;
    private top: TopUnit = "art";

    constructor(private readonly footnotes: ReadonlyMap<number, string>) {}

    read(body: string): void {
        this.top = /class="unit unit_arti\b/u.test(body) ? "art" : "par";
        let at = 0;
        for (const tag of body.matchAll(/<(\/?)(div|h3)\b([^>]*)>/giu)) {
            this.text(body.slice(at, tag.index));
            at = tag.index + tag[0].length;
            if (tag[1] === "/") {
                this.close(tag[2]?.toLowerCase() === "h3" ? "h3" : "div");
            } else {
                this.open(tag[2]?.toLowerCase() === "h3" ? "h3" : "div", tag[3] ?? "");
            }
        }
        this.finish();
    }

    private open(tag: "div" | "h3", attributes: string): void {
        const kind = /class="unit unit_(\w+)/u.exec(attributes)?.[1];
        const collects = tag === "h3" || /data-template="xText"/iu.test(attributes);
        this.stack.push({ tag, kind, collects, text: "" });
    }

    private text(chunk: string): void {
        const collector = this.stack.findLast((frame) => frame.collects);
        if (collector !== undefined && chunk !== "") {
            collector.text += chunk;
        }
    }

    private close(tag: "div" | "h3"): void {
        const index = this.stack.findLastIndex((frame) => frame.tag === tag);
        if (index < 0) {
            return;
        }
        const [frame] = this.stack.splice(index);
        if (frame === undefined || !frame.collects) {
            return;
        }
        const owner = this.stack.findLast((candidate) => candidate.kind !== undefined);
        if (frame.tag === "h3") {
            this.label(owner, frame.text);
        } else {
            this.wording(owner, frame.text);
        }
    }

    private label(owner: Frame | undefined, raw: string): void {
        if (owner?.kind === undefined) {
            return;
        }
        // A regulation's paragraphs are its articles; a paragraph inside one is not.
        const paragraphs = this.stack.filter((frame) => frame.kind === "para").length;
        if ((owner.kind === "arti" && this.top === "art") || (owner.kind === "para" && this.top === "par" && paragraphs === 1)) {
            this.startArticle(raw);
            return;
        }
        if (HEADINGS.has(owner.kind)) {
            owner.heading = headingText(raw.replaceAll(PLACEHOLDER, ""));
            return;
        }
        const level = LEVEL_OF.get(owner.kind);
        if (level !== undefined && this.builder !== undefined) {
            const label = clean(raw.replaceAll(PLACEHOLDER, ""));
            const value = level === "tiret" ? "" : label.replace(/^§\s*/u, "").replace(/[.)]$/u, "");
            owner.unit = this.builder.open(level, value, label);
            this.noteMarkers(raw);
        }
    }

    private wording(owner: Frame | undefined, raw: string): void {
        const text = clean(raw.replaceAll(PLACEHOLDER, ""));
        if (text !== "" && this.builder !== undefined) {
            this.builder.write(owner?.unit, text);
            this.noteMarkers(raw);
        }
    }

    private startArticle(raw: string): void {
        this.finish();
        const key = articleKey(clean(raw.replaceAll(PLACEHOLDER, "")).replace(/\.$/u, ""));
        const heading = this.stack.flatMap((frame) => (frame.heading === undefined ? [] : [frame.heading])).join(" / ");
        this.builder = new ArticleBuilder(key, articleMarker(this.top, key), heading === "" ? undefined : heading);
        this.noteMarkers(raw, true);
    }

    // Notes the footnotes whose placeholders a piece of text carries, against the unit written last (or the article).
    private noteMarkers(text: string, whole = false): void {
        for (const match of text.matchAll(PLACEHOLDER)) {
            const ref = match[1] ?? "";
            const note = this.footnotes.get(Number(ref));
            if (note !== undefined && !CITED_ACT_CHANGES.test(note)) {
                this.builder?.note(`${ref}) ${note}`, whole);
            }
        }
    }

    private finish(): void {
        if (this.builder !== undefined) {
            this.articles.push(this.builder.build());
        }
        this.builder = undefined;
    }
}

const CITED_ACT_CHANGES = /^Zmian[ay]\b.*\bwymienion/u;

// `<sup>1</sup>` in "Art. 39<sup>1</sup>." is a raised article number, printed as such ("Art. 39¹").
const raise = (html: string): string => html.replaceAll(/<sup>\s*([0-9a-z]{1,4})\s*<\/sup>/giu, (_, raised: string) => superscript(raised.toLowerCase()));

export const articlesFromHtml = (html: string): ParsedText => {
    const footnotes = new Map<number, string>();
    const lifted = raise(liftFootnotes(html, footnotes));
    const { body, notice } = textPart(lifted);
    const reader = new Reader(footnotes);
    reader.read(body);
    return { articles: reader.articles, notice: notice === undefined ? undefined : clean(notice.replaceAll(PLACEHOLDER, "")) };
};
