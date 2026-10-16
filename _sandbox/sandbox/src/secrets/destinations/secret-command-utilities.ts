import { type Flags, type Parsed, parseFlags } from "./secret-command-flags.js";
import { type ProgramReader, STAND_IN, type Unreadable } from "./secret-command-words.js";

// Programs a stage may run and still send the value nowhere: they open no socket, run no other program, and change no
// setting (a proxy, a config file, an alias, a PATH) a later stage's curl, wget or git would read. A stage of one of
// these adds no host and hides none, so it neither carries the value out nor sets up a later stage to. What is left out
// is deliberate: an interpreter (`python`, `node`, `perl`, `ruby`), a shell (`sh`, `bash`, `eval`, `source`), `awk` and
// `sed` (each runs a command or opens a socket in some form), `xargs`, `find`, `env`, `tee`, `nc`, `ssh`, `docker` and
// `gh` all stay unread, so a line that uses one still asks. rg, sort, uniq and printf below are inert only in the forms
// their argument readers accept; a name in neither list is unknown, and leaves the line unreadable.
const INERT_PROGRAMS = [
    "cd",
    "pwd",
    "echo",
    "true",
    "false",
    ":",
    "test",
    "[",
    "sleep",
    "date",
    "mkdir",
    "ls",
    "dirname",
    "basename",
    "cat",
    "head",
    "tail",
    "wc",
    "cut",
    "tr",
    "nl",
    "rev",
    "tac",
    "fold",
    "column",
    "base64",
    "grep",
    "egrep",
    "fgrep",
    "jq",
    "comm",
];

const inert: ProgramReader = () => ({ hosts: [] });

const RUNS_PROGRAM = "it runs another program";
const WRITES_FILE = "it writes a file, which can change what a later command does";
const SETS_VARIABLE = "it changes shell variables, which can change what a later command does";

// A utility is inert only in a form whose arguments we understand. Use the same option grammar as the network
// readers: attached values, short clusters and -- must mean the same thing everywhere, and unknown options ask.
const utilityFlags = (values: readonly string[], plain: readonly string[], refuses: readonly (readonly [string, string])[]): Flags => ({
    values: new Set(values),
    plain: new Set(plain),
    refuses: new Map(refuses),
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

// A utility whose arguments its table reads, and, where its operands mean more than input, what they do.
const readUtility =
    (flags: Flags, check?: (parsed: Parsed) => Unreadable | undefined): ProgramReader =>
    (args) => {
        const parsed = parseFlags(args, flags);
        if ("why" in parsed) {
            return parsed;
        }
        return check?.(parsed) ?? { hosts: [] };
    };

// uniq's second operand, once its options and their values are read, is the file it writes.
const uniqOutput = (parsed: Parsed): Unreadable | undefined => (parsed.positionals.length > 1 ? { why: WRITES_FILE } : undefined);

const printfReach: ProgramReader = (args) => {
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

export const UTILITY_READERS: ReadonlyMap<string, ProgramReader> = new Map([
    ...INERT_PROGRAMS.map((name) => [name, inert] as const),
    ["rg", readUtility(RG)],
    ["sort", readUtility(SORT)],
    ["uniq", readUtility(UNIQ, uniqOutput)],
    ["printf", printfReach],
]);
