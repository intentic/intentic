import { parseXml } from "../check/xml-tree.js";
import { ACCENTS } from "./docx-math-symbols.js";
import { escapeLatex, ommlToLatex, withEquationsAsLatex } from "./docx-math.js";

// The cases of markitdown's tests/test_docx_math.py, test_docx_omml.py, test_docx_math_symbols.py and
// test_docx_math_accents.py (MIT, Copyright (c) Microsoft Corporation), against this port, plus the objects those
// tests leave out.

const MATH = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const latex = (inner: string): string => ommlToLatex(parseXml(`<m:oMath xmlns:m="${MATH}">${inner}</m:oMath>`));
const run = (text: string): string => `<m:r><m:t>${text}</m:t></m:r>`;
const accent = (char: string): string => latex(`<m:acc><m:accPr><m:chr m:val="${char}"/></m:accPr><m:e>${run("x")}</m:e></m:acc>`);
const func = (...nameRuns: string[]): string => latex(`<m:func><m:fName>${nameRuns.map(run).join("")}</m:fName><m:e>${run("x")}</m:e></m:func>`);

describe("ommlToLatex: markitdown's cases", () => {
    test("a known function is its LaTeX operator, an unknown one \\operatorname", () => {
        expect(func("log")).toBe("\\log(x)");
        expect(func("customFunc")).toBe("\\operatorname{customFunc}(x)");
    });

    test("a function name Word split across runs is joined before it is looked up", () => {
        expect(func("custom", "Func")).toBe("\\operatorname{customFunc}(x)");
        expect(func("si", "n")).toBe("\\sin(x)");
    });

    test("a run without text is empty, not a failure, and does not cost its neighbours", () => {
        expect(latex("<m:r><m:rPr/></m:r>")).toBe("");
        expect(latex(run("x"))).toBe("x");
        expect(latex(`<m:sSub><m:e>${run("l")}</m:e><m:sub><m:r><m:rPr/></m:r>${run("1")}</m:sub></m:sSub>`)).toBe("l_{1}");
    });

    test("the arrow accents share one naming scheme, U+20EE included", () => {
        expect(accent("⃖")).toBe("\\overleftarrow{x}");
        expect(accent("⃯")).toBe("\\underrightarrow{x}");
        expect(accent("⃮")).toBe("\\underleftarrow{x}");
    });

    test("caron and ring above, which once carried an extra brace, convert like any accent", () => {
        expect(accent("̌")).toBe("\\check{x}");
        expect(accent("̊")).toBe("\\ocirc{x}");
        expect(accent("̂")).toBe("\\hat{x}");
    });

    test("every accent is a bare macro, so none can unbalance the braces it is applied with", () => {
        expect([...ACCENTS.values()].filter((macro) => !/^\\[a-z]+$/i.test(macro))).toEqual([]);
    });

    test("every math italic Latin letter, h at U+210E included, reads as plain ASCII", () => {
        const upper = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter, index): [string, string] => [String.fromCodePoint(0x1d434 + index), letter]);
        const lower = [..."abcdefghijklmnopqrstuvwxyz"].map((letter, index): [string, string] => [
            letter === "h" ? "ℎ" : String.fromCodePoint(0x1d44e + index),
            letter,
        ]);
        const leaked = [...upper, ...lower].filter(([char, letter]) => latex(run(char)) !== letter);
        expect(leaked).toEqual([]);
        expect(latex(run("ℎ(\u{1d465})=\u{1d454}(\u{1d465})"))).toBe("h(x)=g(x)");
    });
});

describe("ommlToLatex: the other objects", () => {
    test("fractions, by type", () => {
        const fraction = (type: string): string =>
            latex(`<m:f><m:fPr>${type === "" ? "" : `<m:type m:val="${type}"/>`}</m:fPr><m:num>${run("a")}</m:num><m:den>${run("b")}</m:den></m:f>`);
        expect(fraction("")).toBe("\\frac{a}{b}");
        expect(fraction("lin")).toBe("{a}/{b}");
        expect(fraction("skw")).toBe("^{a}/_{b}");
        expect(fraction("noBar")).toBe("\\genfrac{}{}{0pt}{}{a}{b}");
    });

    test("scripts, radicals and big operators", () => {
        expect(latex(`<m:sSup><m:e>${run("10")}</m:e><m:sup>${run("-6")}</m:sup></m:sSup>`)).toBe("10^{-6}");
        expect(latex(`<m:sSubSup><m:e>${run("x")}</m:e><m:sub>${run("i")}</m:sub><m:sup>${run("2")}</m:sup></m:sSubSup>`)).toBe("x_{i}^{2}");
        expect(latex(`<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${run("x")}</m:e></m:rad>`)).toBe("\\sqrt{x}");
        expect(latex(`<m:rad><m:deg>${run("3")}</m:deg><m:e>${run("x")}</m:e></m:rad>`)).toBe("\\sqrt[3]{x}");
        const sum = `<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub>${run("i=1")}</m:sub><m:sup>${run("n")}</m:sup><m:e>${run("x")}</m:e></m:nary>`;
        expect(latex(sum)).toBe("\\sum_{i=1}^{n}x");
        // Word leaves out m:chr for its default operator, the integral; a letter after it must not extend its name.
        expect(latex(`<m:nary><m:naryPr/><m:e>${run("f")}</m:e></m:nary>`)).toBe("\\int f");
    });

    test("delimiters keep every argument, joined by their separator", () => {
        expect(latex(`<m:d><m:dPr/><m:e>${run("x")}</m:e></m:d>`)).toBe("\\left(x\\right)");
        expect(latex(`<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val=""/></m:dPr><m:e>${run("0,1")}</m:e></m:d>`)).toBe("\\left[0,1\\right.");
        expect(latex(`<m:d><m:dPr><m:sepChr m:val=","/></m:dPr><m:e>${run("a")}</m:e><m:e>${run("b")}</m:e></m:d>`)).toBe("\\left(a,b\\right)");
    });

    test("limits, matrices and equation arrays", () => {
        const limit = `<m:limLow><m:e>${run("lim")}</m:e><m:lim>${run("n→∞")}</m:lim></m:limLow>`;
        expect(latex(limit)).toBe("\\lim_{n\\to \\infty }");
        expect(latex(`<m:limLow><m:e>${run("x")}</m:e><m:lim>${run("k")}</m:lim></m:limLow>`)).toBe("\\underset{k}{x}");
        const matrix = `<m:m><m:mr><m:e>${run("a")}</m:e><m:e>${run("b")}</m:e></m:mr><m:mr><m:e>${run("c")}</m:e><m:e>${run("d")}</m:e></m:mr></m:m>`;
        expect(latex(matrix)).toBe("\\begin{matrix}a&b\\\\c&d\\end{matrix}");
        expect(latex(`<m:eqArr><m:e>${run("x=1")}</m:e><m:e>${run("y=2")}</m:e></m:eqArr>`)).toBe("\\begin{array}{c}x=1\\\\y=2\\end{array}");
    });

    test("LaTeX's own syntax characters in an equation's text are escaped once", () => {
        expect(latex(run("50% of $x"))).toBe("50\\% of \\$x");
        expect(escapeLatex("a_b \\_c")).toBe("a\\_b \\_c");
    });
});

const part = (body: string, mathPrefix = "m"): string =>
    `<?xml version="1.0"?><w:document xmlns:w="${WORD}" xmlns:${mathPrefix}="${MATH}"><w:body>${body}</w:body></w:document>`;

describe("withEquationsAsLatex", () => {
    test("an inline equation becomes a run of $…$ where it stood", () => {
        const xml = part(`<w:p><w:r><w:t xml:space="preserve">For </w:t></w:r><m:oMath>${run("m")}${run("=1")}</m:oMath><w:r><w:t>,</w:t></w:r></w:p>`);
        const { xml: rewritten, equations } = withEquationsAsLatex(xml);
        expect(equations).toBe(1);
        expect(rewritten).toContain('<w:r><w:t xml:space="preserve">For </w:t></w:r><w:r><w:t xml:space="preserve">$m=1$</w:t></w:r><w:r><w:t>,</w:t></w:r>');
        expect(rewritten).not.toContain("oMath");
    });

    test("each equation of a display paragraph becomes $$…$$ inside that paragraph, a line break between them", () => {
        const xml = part(`<w:p><m:oMathPara><m:oMathParaPr/><m:oMath>${run("a")}</m:oMath><m:oMath>${run("b&lt;c")}</m:oMath></m:oMathPara></w:p>`);
        const { xml: rewritten, equations } = withEquationsAsLatex(xml);
        expect(equations).toBe(2);
        expect(rewritten).toContain(
            '<w:p><w:r><w:t xml:space="preserve">$$a$$</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space="preserve">$$b&lt;c$$</w:t></w:r></w:p>',
        );
    });

    test("the document's own prefixes are honoured, and a part with no Office Math comes back as it was", () => {
        const renamed = part(`<w:p><mm:oMath><mm:r><mm:t>x</mm:t></mm:r></mm:oMath></w:p>`, "mm");
        expect(withEquationsAsLatex(renamed).xml).toContain('<w:t xml:space="preserve">$x$</w:t>');
        const plain = `<w:document xmlns:w="${WORD}"><w:body><w:p><w:r><w:t>m=1</w:t></w:r></w:p></w:body></w:document>`;
        expect(withEquationsAsLatex(plain)).toEqual({ xml: plain, equations: 0 });
    });
});
