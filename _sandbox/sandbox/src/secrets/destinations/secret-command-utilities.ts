import { type Flags, parseFlags } from "./secret-command-flags.js";
import { STAND_IN, type Unreadable, type Word } from "./secret-command-lex.js";

type UtilityReach = { readonly hosts: readonly string[] } | Unreadable;

const RUNS_PROGRAM = "it runs another program";
const WRITES_FILE = "it writes a file, which can change what a later command does";
const SETS_VARIABLE = "it changes shell variables, which can change what a later command does";

// A utility is inert only in a form whose arguments we understand. Use the same option grammar as the network
// readers: attached values, short clusters and -- must mean the same thing everywhere, and unknown options ask.
const utilityFlags = (values: readonly string[], plain: readonly string[], steers: readonly (readonly [string, string])[]): Flags => ({
    values: new Set(values),
    plain: new Set(plain),
    steers: new Map(steers),
});

const SORT = utilityFlags(
    [..."kStT", "key", "buffer-size", "field-separator", "temporary-directory", "batch-size", "parallel", "random-source", "sort"],
    [
        ..."bdfgihMnRrVcCmsuz",
        "ignore-leading-blanks",
        "dictionary-order",
        "ignore-case",
        "general-numeric-sort",
        "ignore-nonprinting",
        "human-numeric-sort",
        "month-sort",
        "numeric-sort",
        "random-sort",
        "reverse",
        "version-sort",
        "check",
        "merge",
        "stable",
        "unique",
        "zero-terminated",
        "debug",
        "help",
        "version",
    ],
    [
        ["o", WRITES_FILE],
        ["output", WRITES_FILE],
        ["compress-program", RUNS_PROGRAM],
    ],
);

const UNIQ = utilityFlags(
    [..."fsw", "skip-fields", "skip-chars", "check-chars"],
    [..."cdDiuz", "count", "repeated", "all-repeated", "ignore-case", "unique", "zero-terminated", "group", "help", "version"],
    [],
);

const RG = utilityFlags(
    [
        ..."efEjmgdtTABCMr",
        "regexp",
        "file",
        "encoding",
        "max-count",
        "threads",
        "glob",
        "iglob",
        "max-depth",
        "type",
        "type-not",
        "type-add",
        "type-clear",
        "after-context",
        "before-context",
        "context",
        "max-columns",
        "replace",
        "pre-glob",
        "dfa-size-limit",
        "engine",
        "regex-size-limit",
        "ignore-file",
        "max-filesize",
        "color",
        "colors",
        "context-separator",
        "field-context-separator",
        "field-match-separator",
        "hyperlink-format",
        "path-separator",
        "sort",
        "sortr",
    ],
    [
        ..."sFivxUPSwaL.ubhnN0opqHIclV",
        "case-sensitive",
        "crlf",
        "fixed-strings",
        "ignore-case",
        "invert-match",
        "line-regexp",
        "mmap",
        "multiline",
        "multiline-dotall",
        "no-unicode",
        "null-data",
        "pcre2",
        "smart-case",
        "stop-on-nonmatch",
        "text",
        "auto-hybrid-regex",
        "no-pcre2-unicode",
        "binary",
        "follow",
        "glob-case-insensitive",
        "hidden",
        "ignore-file-case-insensitive",
        "no-ignore",
        "no-ignore-dot",
        "no-ignore-exclude",
        "no-ignore-files",
        "no-ignore-global",
        "no-ignore-parent",
        "no-ignore-vcs",
        "no-require-git",
        "one-file-system",
        "unrestricted",
        "block-buffered",
        "byte-offset",
        "column",
        "heading",
        "help",
        "include-zero",
        "line-buffered",
        "line-number",
        "no-line-number",
        "max-columns-preview",
        "null",
        "only-matching",
        "passthru",
        "pretty",
        "quiet",
        "trim",
        "vimgrep",
        "with-filename",
        "no-filename",
        "sort-files",
        "count",
        "count-matches",
        "files-with-matches",
        "files-without-match",
        "json",
        "debug",
        "no-ignore-messages",
        "no-messages",
        "stats",
        "trace",
        "files",
        "no-config",
        "pcre2-version",
        "type-list",
        "version",
    ],
    [
        ["pre", RUNS_PROGRAM],
        ["hostname-bin", RUNS_PROGRAM],
        ["z", RUNS_PROGRAM],
        ["search-zip", RUNS_PROGRAM],
    ],
);

const readUtility = (args: readonly Word[], flags: Flags, maxInputs = Infinity): UtilityReach => {
    const parsed = parseFlags(args, flags);
    if ("why" in parsed) {
        return parsed;
    }
    // uniq's second operand is an output file, after its options (including their values) have been consumed.
    return parsed.positionals.length > maxInputs ? { why: WRITES_FILE } : { hosts: [] };
};

const printfReach = (args: readonly Word[]): UtilityReach => {
    const [first] = args;
    if (first?.text.startsWith("-v")) {
        return { why: SETS_VARIABLE };
    }
    const format = first?.text === "--" ? args.at(1) : first;
    if (format === undefined) {
        return { hosts: [] };
    }
    if (format.dynamic || format.text.includes(STAND_IN)) {
        return { why: "the printf format is filled in when it runs" };
    }
    // %% is literal; %n (with optional width, precision or length modifiers) assigns to a shell variable.
    const conversions = format.text.matchAll(/%%|%[-+ #'0]*(?:\d+|\*)?(?:\.(?:\d+|\*)?)?[hlLjzt]*n/g);
    return [...conversions].some((match) => match[0] !== "%%") ? { why: SETS_VARIABLE } : { hosts: [] };
};

export const UTILITY_READERS: ReadonlyMap<string, (args: readonly Word[]) => UtilityReach> = new Map([
    ["rg", (args) => readUtility(args, RG)],
    ["sort", (args) => readUtility(args, SORT)],
    ["uniq", (args) => readUtility(args, UNIQ, 1)],
    ["printf", printfReach],
]);
