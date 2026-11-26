// The symbol tables docx-math.ts converts Office Math with. Ported from markitdown's
// packages/markitdown/src/markitdown/converter_utils/docx/math/latex_dict.py (https://github.com/microsoft/markitdown,
// MIT, Copyright (c) Microsoft Corporation), itself adapted from dwml's dwml/latex_dict.py
// (https://github.com/xiilei/dwml, Apache-2.0, by xilei; ../../../NOTICE). Kept: every mapping and markitdown's fixes to them
// (U+20EE is \underleftarrow, the math italic h is U+210E). Changed: a template is a macro name applied as
// `\macro{…}` rather than a str.format string, so no table entry can carry an unbalanced brace.

/** Characters LaTeX reads as syntax, escaped with a backslash when they come from an equation's text. */
export const LATEX_SPECIALS = new Set(["{", "}", "_", "^", "#", "&", "$", "%", "~"]);

/** Accent and over/under characters (`m:chr` of an accent, bar or group character) to the macro that sets them. */
export const ACCENTS: ReadonlyMap<string, string> = new Map([
    // Top accents
    ["\u0300", "\\grave"],
    ["\u0301", "\\acute"],
    ["\u0302", "\\hat"],
    ["\u0303", "\\tilde"],
    ["\u0304", "\\bar"],
    ["\u0305", "\\overbar"],
    ["\u0306", "\\breve"],
    ["\u0307", "\\dot"],
    ["\u0308", "\\ddot"],
    ["\u0309", "\\ovhook"],
    ["\u030a", "\\ocirc"],
    ["\u030c", "\\check"],
    ["\u0310", "\\candra"],
    ["\u0312", "\\oturnedcomma"],
    ["\u0315", "\\ocommatopright"],
    ["\u031a", "\\droang"],
    ["\u0338", "\\not"],
    ["\u20d0", "\\leftharpoonaccent"],
    ["\u20d1", "\\rightharpoonaccent"],
    ["\u20d2", "\\vertoverlay"],
    ["\u20d6", "\\overleftarrow"],
    ["\u20d7", "\\vec"],
    ["\u20db", "\\dddot"],
    ["\u20dc", "\\ddddot"],
    ["\u20e1", "\\overleftrightarrow"],
    ["\u20e7", "\\annuity"],
    ["\u20e9", "\\widebridgeabove"],
    ["\u20f0", "\\asteraccent"],
    // Bottom accents
    ["\u0330", "\\wideutilde"],
    ["\u0331", "\\underbar"],
    ["\u20e8", "\\threeunderdot"],
    ["\u20ec", "\\underrightharpoondown"],
    ["\u20ed", "\\underleftharpoondown"],
    ["\u20ee", "\\underleftarrow"],
    ["\u20ef", "\\underrightarrow"],
    // Over and under groups
    ["\u23b4", "\\overbracket"],
    ["\u23dc", "\\overparen"],
    ["\u23de", "\\overbrace"],
    ["\u23b5", "\\underbracket"],
    ["\u23dd", "\\underparen"],
    ["\u23df", "\\underbrace"],
]);

/** An accent with no `m:chr` is a hat; a group character with none is an underbrace. */
export const DEFAULT_ACCENT = "\\hat";
export const DEFAULT_GROUP_CHR = "\\underbrace";

/** A bar's `m:pos`; with none it is an overline. */
export const BAR_POSITIONS: ReadonlyMap<string, string> = new Map([
    ["top", "\\overline"],
    ["bot", "\\underline"],
]);
export const DEFAULT_BAR = "\\overline";

/** Big operators (`m:chr` of an n-ary); an n-ary with no `m:chr` is an integral, as Word draws it. */
export const BIG_OPERATORS: ReadonlyMap<string, string> = new Map([
    ["\u2140", "\\Bbbsum"],
    ["\u220f", "\\prod"],
    ["\u2210", "\\coprod"],
    ["\u2211", "\\sum"],
    ["\u222b", "\\int"],
    ["\u22c0", "\\bigwedge"],
    ["\u22c1", "\\bigvee"],
    ["\u22c2", "\\bigcap"],
    ["\u22c3", "\\bigcup"],
    ["\u2a00", "\\bigodot"],
    ["\u2a01", "\\bigoplus"],
    ["\u2a02", "\\bigotimes"],
]);
export const DEFAULT_BIG_OPERATOR = "\\int";

// Mathematical italic letters back to ASCII. Lowercase has a hole at U+1D455: that letter is U+210E (Planck's h).
const italic = (first: number, letters: string, skip?: number): [string, string][] =>
    [...letters].flatMap((letter, index): [string, string][] => (first + index === skip ? [] : [[String.fromCodePoint(first + index), letter]]));

const GREEK = [
    "alpha",
    "beta",
    "gamma",
    "delta",
    "epsilon",
    "zeta",
    "eta",
    "theta",
    "iota",
    "kappa",
    "lambda",
    "mu",
    "nu",
    "xi",
    "omicron",
    "pi",
    "rho",
    "varsigma",
    "sigma",
    "tau",
    "upsilon",
    "phi",
    "chi",
    "psi",
    "omega",
    "partial",
    "varepsilon",
    "vartheta",
    "varkappa",
    "varphi",
    "varrho",
    "varpi",
];

/** Characters of an equation's text to LaTeX; a macro keeps a trailing space so the next letter cannot extend it. */
export const SYMBOLS: ReadonlyMap<string, string> = new Map<string, string>([
    // Mathematical italic Greek, U+1D6FC onwards
    ...GREEK.map((name, index): [string, string] => [String.fromCodePoint(0x1d6fc + index), `\\${name} `]),
    // Arrows and relations
    ["\u2190", "\\leftarrow "],
    ["\u2191", "\\uparrow "],
    ["\u2192", "\\rightarrow "],
    ["\u2193", "\\downarrow "],
    ["\u2194", "\\leftrightarrow "],
    ["\u2195", "\\updownarrow "],
    ["\u2196", "\\nwarrow "],
    ["\u2197", "\\nearrow "],
    ["\u2198", "\\searrow "],
    ["\u2199", "\\swarrow "],
    ["\u22ee", "\\vdots "],
    ["\u22ef", "\\cdots "],
    ["\u22f0", "\\adots "],
    ["\u22f1", "\\ddots "],
    ["\u2260", "\\ne "],
    ["\u2264", "\\leq "],
    ["\u2265", "\\geq "],
    ["\u2266", "\\leqq "],
    ["\u2267", "\\geqq "],
    ["\u2268", "\\lneqq "],
    ["\u2269", "\\gneqq "],
    ["\u226a", "\\ll "],
    ["\u226b", "\\gg "],
    ["\u2208", "\\in "],
    ["\u2209", "\\notin "],
    ["\u220b", "\\ni "],
    ["\u220c", "\\nni "],
    ["\u221e", "\\infty "],
    ["\u00b1", "\\pm "],
    ["\u2213", "\\mp "],
    // Mathematical italic Latin
    ...italic(0x1d434, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    ...italic(0x1d44e, "abcdefghijklmnopqrstuvwxyz", 0x1d455),
    ["\u210e", "h"],
    // The invisible function-application, times, separator and plus operators carry nothing a reader sees.
    ["\u2061", ""],
    ["\u2062", ""],
    ["\u2063", ""],
    ["\u2064", ""],
]);

/** Function names (`m:fName`) with a LaTeX operator of their own; any other name is set with \operatorname. */
export const FUNCTIONS: ReadonlyMap<string, string> = new Map([
    ...["sin", "cos", "tan", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth", "sec", "csc", "log", "ln", "exp"].map(
        (name): [string, string] => [name, `\\${name}`],
    ),
    ...["det", "gcd", "lim", "max", "min", "sup", "inf", "dim", "ker", "hom", "deg", "arg"].map((name): [string, string] => [name, `\\${name}`]),
    ["arccot", "\\operatorname{arccot}"],
    ["lcm", "\\operatorname{lcm}"],
]);

/** Lower-limit objects (`m:limLow`) whose base is one of these are set as that operator with a subscript. */
export const LIMIT_OPERATORS: ReadonlyMap<string, string> = new Map([
    ["lim", "\\lim"],
    ["max", "\\max"],
    ["min", "\\min"],
]);

/** A fraction's `m:type` to how it is set; with none it is a stacked \frac. */
export const FRACTIONS: ReadonlyMap<string, (num: string, den: string) => string> = new Map([
    ["bar", (num: string, den: string) => `\\frac{${num}}{${den}}`],
    ["skw", (num: string, den: string) => `^{${num}}/_{${den}}`],
    ["noBar", (num: string, den: string) => `\\genfrac{}{}{0pt}{}{${num}}{${den}}`],
    ["lin", (num: string, den: string) => `{${num}}/{${den}}`],
]);

export const LINE_BREAK = "\\\\";
