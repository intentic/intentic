import { readFile } from "node:fs/promises";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { childrenNamed, isElement, parseXml, type XmlElement } from "../check/xml-tree.js";
import {
    ACCENTS,
    BAR_POSITIONS,
    BIG_OPERATORS,
    DEFAULT_ACCENT,
    DEFAULT_BAR,
    DEFAULT_BIG_OPERATOR,
    DEFAULT_GROUP_CHR,
    FRACTIONS,
    FUNCTIONS,
    LATEX_SPECIALS,
    LIMIT_OPERATORS,
    LINE_BREAK,
    SYMBOLS,
} from "./docx-math-symbols.js";

// Word's equations (Office Math, OMML) as LaTeX: mammoth skips m:oMath and m:oMathPara with a warning, so "For m=1,"
// read "For ,". Before mammoth sees the document, each equation in the parts it reads is replaced by a plain text run
// holding its LaTeX, `$…$` inline and `$$…$$` for a display equation; a document with no equation is handed to mammoth
// untouched. Ported from markitdown's converter_utils/docx/pre_process.py and math/omml.py
// (https://github.com/microsoft/markitdown, MIT, Copyright (c) Microsoft Corporation), which adapt dwml's
// dwml/omml.py (https://github.com/xiilei/dwml, Apache-2.0, by xilei; ../../../NOTICE). What differs: an equation the converter
// cannot read falls back to its text alone rather than dropping every equation in the document; a delimiter keeps all
// of its arguments, joined by its separator, rather than the last; a pre-sub-superscript and a border box keep their
// content; an n-ary with no operator character is an integral, as Word draws it; and a display equation's runs stay
// inside the paragraph that held them rather than becoming a paragraph nested in it.

const MATH_NAMESPACES = ["http://schemas.openxmlformats.org/officeDocument/2006/math", "http://purl.oclc.org/ooxml/officeDocument/math"];
const WORD_NAMESPACES = ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"];

// The parts mammoth reads that can hold an equation, as markitdown pre-processes them.
const MATH_PARTS = new Set(["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"]);

// Elements whose LaTeX is simply their children's, in order.
const TRANSPARENT = new Set(["box", "borderBox", "sSub", "sSup", "sSubSup", "num", "den", "deg", "e"]);

/** An element converted: its LaTeX, and for a property element (`m:fPr`, `m:dPr`…) the values it sets. */
interface Converted {
    /** A property element's text is the line breaks it carries, which dwml sets before the object. */
    readonly text: string;
    readonly val?: (name: string) => string | undefined;
}

const NO_PROPS: Converted = { text: "", val: () => undefined };

interface Child {
    readonly tag: string;
    readonly value: Converted;
}

/** Converts one equation tree; `prefix` is the namespace prefix the document wrote Office Math under. */
class OmmlToLatex {
    constructor(private readonly prefix: string) {}

    private local(element: XmlElement): string | undefined {
        return element.name.startsWith(`${this.prefix}:`) ? element.name.slice(this.prefix.length + 1) : undefined;
    }

    // The math children of an element converted, in order; Word's own elements inside them (w:rPr) carry no math.
    private children(element: XmlElement, include?: readonly string[]): Child[] {
        return element.children.filter(isElement).flatMap((child) => {
            const tag = this.local(child);
            if (tag === undefined || (include !== undefined && !include.includes(tag))) {
                return [];
            }
            const value = this.convert(child, tag);
            return value === undefined ? [] : [{ tag, value }];
        });
    }

    private joined(element: XmlElement, include?: readonly string[]): string {
        return this.children(element, include)
            .map((child) => child.value.text)
            .join("");
    }

    // The last child of each kind, as dwml reads an object's parts (its `e`, its `fPr`).
    private parts(element: XmlElement): Map<string, Converted> {
        return new Map(this.children(element).map((child) => [child.tag, child.value]));
    }

    private part(element: XmlElement, tag: string): string {
        return this.parts(element).get(tag)?.text ?? "";
    }

    private props(element: XmlElement, tag: string): Converted {
        const value = this.parts(element).get(tag);
        return value?.val === undefined ? NO_PROPS : value;
    }

    private readProps(element: XmlElement): Converted {
        const vals = new Map<string, string>();
        for (const child of element.children.filter(isElement)) {
            const tag = this.local(child);
            const value = child.attrs[`${this.prefix}:val`];
            if (tag !== undefined && value !== undefined) {
                vals.set(tag, value);
            }
        }
        const breaks = element.children.filter((child) => isElement(child) && this.local(child) === "brk").length;
        return { text: LINE_BREAK.repeat(breaks), val: (name) => vals.get(name) };
    }

    /** The LaTeX of an `m:oMath`. */
    latex(element: XmlElement): string {
        return this.joined(element);
    }

    private convert(element: XmlElement, tag: string): Converted | undefined {
        const handler = this.handlers.get(tag);
        if (handler !== undefined) {
            return { text: handler(element) };
        }
        if (TRANSPARENT.has(tag)) {
            return { text: this.joined(element) };
        }
        return tag.endsWith("Pr") ? this.readProps(element) : undefined;
    }

    private readonly handlers = new Map<string, (element: XmlElement) => string>([
        ["r", (element) => this.run(element)],
        ["acc", (element) => `${macro(ACCENTS, this.props(element, "accPr").val?.("chr"), DEFAULT_ACCENT)}{${this.part(element, "e")}}`],
        ["bar", (element) => this.decorated(element, "barPr", "pos", BAR_POSITIONS, DEFAULT_BAR)],
        ["groupChr", (element) => this.decorated(element, "groupChrPr", "chr", ACCENTS, DEFAULT_GROUP_CHR)],
        ["d", (element) => this.delimiter(element)],
        ["sub", (element) => `_{${this.joined(element)}}`],
        ["sup", (element) => `^{${this.joined(element)}}`],
        ["sPre", (element) => `{}_{${this.part(element, "sub")}}^{${this.part(element, "sup")}}${this.part(element, "e")}`],
        ["f", (element) => this.fraction(element)],
        ["func", (element) => this.part(element, "fName").replace(FUNCTION_ARGUMENT, () => this.part(element, "e"))],
        ["fName", (element) => this.functionName(element)],
        ["rad", (element) => this.radical(element)],
        ["eqArr", (element) => `\\begin{array}{c}${this.list(element, "e", LINE_BREAK)}\\end{array}`],
        ["limLow", (element) => this.lowerLimit(element)],
        ["limUpp", (element) => `\\overset{${this.part(element, "lim")}}{${this.part(element, "e")}}`],
        ["lim", (element) => this.joined(element).replaceAll("\\rightarrow", "\\to")],
        ["m", (element) => `\\begin{matrix}${this.list(element, "mr", LINE_BREAK)}\\end{matrix}`],
        ["mr", (element) => this.list(element, "e", "&")],
        ["nary", (element) => this.nary(element)],
    ]);

    // A bar or a group character: its macro, from the property `key` of `propsTag`, over the base.
    private decorated(element: XmlElement, propsTag: string, key: string, table: ReadonlyMap<string, string>, fallback: string): string {
        const props = this.props(element, propsTag);
        return `${props.text}${macro(table, props.val?.(key), fallback)}{${this.part(element, "e")}}`;
    }

    private fraction(element: XmlElement): string {
        const props = this.props(element, "fPr");
        const set = FRACTIONS.get(props.val?.("type") ?? "bar") ?? FRACTIONS.get("bar");
        return props.text + (set?.(this.part(element, "num"), this.part(element, "den")) ?? "");
    }

    private radical(element: XmlElement): string {
        const degree = this.part(element, "deg");
        return degree === "" ? `\\sqrt{${this.part(element, "e")}}` : `\\sqrt[${degree}]{${this.part(element, "e")}}`;
    }

    // A lower limit under lim, max or min is that operator's subscript; under anything else it is set beneath it.
    private lowerLimit(element: XmlElement): string {
        const base = this.part(element, "e");
        const limit = this.part(element, "lim");
        const operator = LIMIT_OPERATORS.get(base);
        return operator === undefined ? `\\underset{${limit}}{${base}}` : `${operator}_{${limit}}`;
    }

    private list(element: XmlElement, tag: string, separator: string): string {
        return this.children(element, [tag])
            .map((child) => child.value.text)
            .join(separator);
    }

    // A run's text, each character mapped to its LaTeX symbol and LaTeX's own syntax characters escaped.
    private run(element: XmlElement): string {
        const [t] = childrenNamed(element, `${this.prefix}:t`);
        const raw = (t?.children ?? []).filter((child): child is string => !isElement(child)).join("");
        return escapeLatex([...raw].map((char) => SYMBOLS.get(char) ?? char).join(""));
    }

    private delimiter(element: XmlElement): string {
        const props = this.props(element, "dPr");
        const side = (key: string, fallback: string): string => {
            const char = props.val?.(key) ?? fallback;
            return char === "" ? "." : escapeLatex(SYMBOLS.get(char) ?? char);
        };
        const separator = escapeLatex(props.val?.("sepChr") ?? "|");
        return `${props.text}\\left${side("begChr", "(")}${this.list(element, "e", separator)}\\right${side("endChr", ")")}`;
    }

    // A function's name: runs joined first (Word splits a name at a formatting boundary), then looked up, the argument
    // left as a placeholder `func` fills.
    private functionName(element: XmlElement): string {
        const out: string[] = [];
        let name = "";
        const flush = (): void => {
            if (name !== "") {
                out.push(`${FUNCTIONS.get(name) ?? `\\operatorname{${name}}`}(${FUNCTION_ARGUMENT})`);
                name = "";
            }
        };
        for (const child of this.children(element)) {
            if (child.tag === "r") {
                name += child.value.text;
            } else {
                flush();
                out.push(child.value.text);
            }
        }
        flush();
        const joined = out.join("");
        return joined.includes(FUNCTION_ARGUMENT) ? joined : `${joined}${FUNCTION_ARGUMENT}`;
    }

    private nary(element: XmlElement): string {
        let operator = DEFAULT_BIG_OPERATOR;
        const rest: string[] = [];
        for (const child of this.children(element)) {
            if (child.tag === "naryPr") {
                const char = child.value.val?.("chr");
                operator = char === undefined ? DEFAULT_BIG_OPERATOR : (BIG_OPERATORS.get(char) ?? char);
            } else {
                rest.push(child.value.text);
            }
        }
        const body = rest.join("");
        // A letter straight after the operator would extend its name (\sumx).
        return /^[a-z]/i.test(body) ? `${operator} ${body}` : `${operator}${body}`;
    }
}

const FUNCTION_ARGUMENT = "{fe}";

const macro = (table: ReadonlyMap<string, string>, char: string | undefined, fallback: string): string =>
    char === undefined ? fallback : (table.get(char) ?? fallback);

/** LaTeX's syntax characters in an equation's text escaped, unless a backslash already escapes them; exported for tests. */
export const escapeLatex = (raw: string): string => {
    let out = "";
    let last = "";
    for (const char of raw.replaceAll("\\\\", "\\")) {
        out += LATEX_SPECIALS.has(char) && last !== "\\" ? `\\${char}` : char;
        last = char;
    }
    return out;
};

const plainText = (element: XmlElement): string => element.children.map((child) => (isElement(child) ? plainText(child) : child)).join("");

/** The LaTeX of one `m:oMath` element, or of a fragment holding one; exported for tests. */
export const ommlToLatex = (element: XmlElement, prefix = "m"): string => {
    try {
        return new OmmlToLatex(prefix).latex(element);
    } catch {
        // An equation the converter cannot read still says what it says.
        return escapeLatex(plainText(element).replaceAll(/\s+/g, " ").trim());
    }
};

const xmlText = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const prefixFor = (xml: string, namespaces: readonly string[]): string | undefined => {
    for (const match of xml.matchAll(/\sxmlns:([\w.-]+)\s*=\s*["']([^"']*)["']/g)) {
        if (namespaces.includes(match[2] ?? "")) {
            return match[1];
        }
    }
    return undefined;
};

interface EquationSpan {
    readonly start: number;
    readonly end: number;
    /** An m:oMathPara (one or more display equations) rather than an inline m:oMath. */
    readonly display: boolean;
}

/** The outermost equations in a part, display and inline, in document order. */
const equationSpans = (xml: string, prefix: string): EquationSpan[] => {
    const tag = new RegExp(`<(/?)${prefix.replaceAll(".", "\\.")}:(oMathPara|oMath)(?=[\\s/>])(?:"[^"]*"|'[^']*'|[^'">])*?(/?)>`, "g");
    const spans: EquationSpan[] = [];
    let depth = 0;
    let open: { start: number; display: boolean } | undefined;
    for (const match of xml.matchAll(tag)) {
        const [whole, closing, name, selfClosing] = match;
        if (closing === "" && depth === 0) {
            open = { start: match.index, display: name === "oMathPara" };
        }
        depth += closing === "/" ? -1 : selfClosing === "/" ? 0 : 1;
        if (depth <= 0 && open !== undefined) {
            spans.push({ ...open, end: match.index + whole.length });
            open = undefined;
            depth = 0;
        }
    }
    return spans;
};

interface RewrittenPart {
    readonly xml: string;
    /** How many equations became LaTeX; none means the part came back as it was. */
    readonly equations: number;
}

/**
 * A part's XML with each equation replaced by a run of its LaTeX: `$…$` inline, `$$…$$` for each equation of a display
 * paragraph. Exported for tests; a part with no Office Math comes back as it was.
 */
export const withEquationsAsLatex = (xml: string): RewrittenPart => {
    const math = prefixFor(xml, MATH_NAMESPACES);
    if (math === undefined) {
        return { xml, equations: 0 };
    }
    const word = prefixFor(xml, WORD_NAMESPACES) ?? "w";
    const run = (latex: string): string => `<${word}:r><${word}:t xml:space="preserve">${xmlText(latex)}</${word}:t></${word}:r>`;
    let out = "";
    let cursor = 0;
    let equations = 0;
    for (const span of equationSpans(xml, math)) {
        const root = parseXml(xml.slice(span.start, span.end));
        const each = span.display ? childrenNamed(root, `${math}:oMath`) : [root];
        out += xml.slice(cursor, span.start) + each.map((equation) => run(span.display ? `$$${ommlToLatex(equation, math)}$$` : `$${ommlToLatex(equation, math)}$`)).join(`<${word}:r><${word}:br/></${word}:r>`);
        cursor = span.end;
        equations += each.length;
    }
    return { xml: out + xml.slice(cursor), equations };
};

/**
 * What to hand mammoth for a Word document: its path when no part holds an equation (the conversion is then exactly
 * what it always was), else the document rebuilt in memory with every equation as LaTeX text.
 */
export const mammothInput = async (absPath: string): Promise<{ path: string } | { buffer: Buffer }> => {
    const bytes = new Uint8Array(await readFile(absPath));
    const parts = unzipSync(bytes, { filter: (file) => MATH_PARTS.has(file.name) });
    const rewritten = Object.entries(parts).flatMap(([name, data]): [string, string][] => {
        const xml = strFromU8(data);
        if (!xml.includes(":oMath")) {
            return [];
        }
        const converted = withEquationsAsLatex(xml);
        return converted.equations === 0 ? [] : [[name, converted.xml]];
    });
    if (rewritten.length === 0) {
        return { path: absPath };
    }
    const files = unzipSync(bytes);
    for (const [name, xml] of rewritten) {
        files[name] = strToU8(xml);
    }
    // Stored rather than deflated: the archive lives only as long as mammoth's read of it.
    return { buffer: Buffer.from(zipSync(files, { level: 0 })) };
};
