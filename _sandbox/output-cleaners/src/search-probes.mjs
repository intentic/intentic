// What a shell search that found nothing would have found with one switch changed: `rg PATTERN [PATH…]` or
// `grep -r PATTERN [PATH…]` that exited 1 with nothing printed is run again as count-only probes (any case, ignored and
// hidden files in for rg, the pattern as plain text), and the files they list are said under the empty result.
//
// A copy of @intentic/text-search's probes (src/probes.ts) for the rg reading and the note, because this package is
// builtins-only (the image copies it to /usr/local/bin as written); src/tests/search-probes.test.mjs holds the two
// together. Only a command read with certainty is probed: a wrong probe is worse than none, so anything this does not
// fully understand (a pipe other than a trailing head or tail, a subshell, a variable, an unquoted glob, a flag not
// listed below) is left alone.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// All probes share this, run one after another (filterRun is synchronous); each is killed once it is spent.
export const PROBE_BUDGET_MS = 1_500;
const EXAMPLES = 3;
const FILE_CAP = 200;
// Bytes of file names read per probe; past it the count is a floor.
const LISTED_BYTES = 256 * 1024;

// Regex syntax that reads differently as plain text; a dot is left out, as a regex dot matches a dot too.
export const REGEX_SYNTAX = /[\\[\](){}?*+^$|]/;
export const hasCase = (pattern) => pattern.toLowerCase() !== pattern.toUpperCase();

// Trees the ignored-and-hidden probe still leaves out (text-search's PROBE_PRUNED_DIRS has the reasons).
const PROBE_PRUNED_DIRS = ".git .hg .svn node_modules .pnpm-store .yarn .npm .venv venv site-packages __pycache__ .cache .turbo .mypy_cache .pytest_cache .ruff_cache .tox .gradle .m2 target".split(
    " ",
);

// The workspace's machine state and reference shelf pruned too (text-search's PROBE_PRUNE_GLOBS has the reasons).
export const PROBE_PRUNE_GLOBS = [...PROBE_PRUNED_DIRS.map((dir) => `!**/${dir}`), "!/refs", "!**/.intentic/local", "!**/.intentic/records"];

export const RG_LABELS = {
    case: "case-insensitive (-i)",
    ignored: "in ignored/hidden files (-uu)",
    literal: "as literal text (-F)",
};

const counted = (hit) => `${String(hit.files)}${hit.more ? "+" : ""} ${hit.files === 1 && !hit.more ? "file" : "files"}`;
const examplesOf = (hit) => `${hit.examples.join(", ")}${hit.more || hit.files > hit.examples.length ? ", …" : ""}`;

export const probeNote = (hits, labels = RG_LABELS) =>
    hits.length === 0
        ? undefined
        : `no matches. Would match: ${hits.map((hit) => `${labels[hit.kind]} → ${counted(hit)} (${examplesOf(hit)})`).join("; ")}`;

// ---- Reading the command line ----------------------------------------------------------------------------------------

// Characters the shell would act on outside quotes: expansion, grouping, redirection, globbing, history, comments.
const UNQUOTED_SPECIAL = new Set(["$", "`", "(", ")", "<", ">", ";", "*", "?", "[", "]", "{", "}", "!", "~", "#", "&", "|", "\n", "\r"]);
// The two redirections that change nothing about stdout's emptiness.
const HARMLESS_REDIRECTS = ["2>/dev/null", "2>&1"];
const GLOB_CHARACTERS = new Set(["*", "?", "[", "]", "{", "}"]);

// A double-quoted run from just past its quote: its text and the index of the closing quote, or undefined for an
// expansion inside it or no closing quote.
const doubleQuoted = (line, start) => {
    let text = "";
    for (let index = start; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
            return { text, end: index };
        }
        if (character === "$" || character === "`") {
            return undefined;
        }
        const escaped = character === "\\" && '$`"\\'.includes(line[index + 1] ?? "");
        text += escaped ? line[index + 1] : character;
        index += escaped ? 1 : 0;
    }
    return undefined;
};

// The operator at `index` this reads (`&&`, a lone `|`, a harmless redirection), with its length; undefined for none.
const operatorAt = (line, index) => {
    if (line.startsWith("&&", index)) {
        return { token: { op: "&&" }, length: 2 };
    }
    if (line[index] === "|" && line[index + 1] !== "|" && line[index + 1] !== "&") {
        return { token: { op: "|" }, length: 1 };
    }
    const redirect = HARMLESS_REDIRECTS.find((text) => line.startsWith(text, index) && /^(?:\s|$)/.test(line.slice(index + text.length)));
    return redirect === undefined ? undefined : { token: { op: "redirect" }, length: redirect.length };
};

// An unquoted glob character is let through only inside a long option's value (`--include=*.ts`): bash would expand it
// only to a file named like the option itself, which nothing is. A `!` is literal anywhere but a command's first word.
const literalInWord = (word, character) => (GLOB_CHARACTERS.has(character) && /^--[\w-]+=/.test(word)) || (character === "!" && word !== "");

// One step of reading at `index`: text added to the word in progress, or the word's end (with an operator after it),
// and where reading goes on; undefined where the shell would do more than split and unquote.
const stepAt = (line, index, word) => {
    const character = line[index];
    const operator = word === undefined ? operatorAt(line, index) : undefined;
    if (operator !== undefined) {
        return { token: operator.token, next: index + operator.length };
    }
    if (character === " " || character === "\t") {
        return { next: index + 1 };
    }
    if (character === "'" || character === '"') {
        const quoted = character === "'" ? singleQuoted(line, index + 1) : doubleQuoted(line, index + 1);
        return quoted === undefined ? undefined : { text: quoted.text, next: quoted.end + 1 };
    }
    if (character === "\\") {
        return index + 1 < line.length && line[index + 1] !== "\n" ? { text: line[index + 1], next: index + 2 } : undefined;
    }
    return UNQUOTED_SPECIAL.has(character) && !literalInWord(word ?? "", character) ? undefined : { text: character, next: index + 1 };
};

// The line as tokens (words, `&&`, `|`, harmless redirections), or undefined when the shell would do anything more with
// it than split and unquote.
const shellTokens = (line) => {
    const tokens = [];
    let word;
    for (let index = 0; index < line.length; ) {
        const step = stepAt(line, index, word);
        if (step === undefined) {
            return undefined;
        }
        if (step.text === undefined) {
            tokens.push(...(word === undefined ? [] : [{ word }]), ...(step.token === undefined ? [] : [step.token]));
            word = undefined;
        } else {
            word = (word ?? "") + step.text;
        }
        index = step.next;
    }
    return word === undefined ? tokens : [...tokens, { word }];
};

const singleQuoted = (line, start) => {
    const end = line.indexOf("'", start);
    return end === -1 ? undefined : { text: line.slice(start, end), end };
};

// Tokens split at an operator, dropping the harmless redirections.
const splitAt = (tokens, op) => {
    const parts = [[]];
    for (const token of tokens) {
        if (token.op === op) {
            parts.push([]);
        } else if (token.op !== "redirect") {
            parts.at(-1).push(token);
        }
    }
    return parts;
};

// A trailing `head`/`tail` with nothing but a line count: it shows a prefix of an empty output, which is empty.
const isLineCut = (words) =>
    (words[0] === "head" || words[0] === "tail") &&
    (words.length === 1 ||
        (words.length === 2 && /^-(?:n)?\d+$/.test(words[1])) ||
        (words.length === 3 && words[1] === "-n" && /^\d+$/.test(words[2])));

const wordsOf = (tokens) => (tokens.every((token) => token.word !== undefined) ? tokens.map((token) => token.word) : undefined);

// The search's words and the directory it ran in: leading `cd DIR &&`s followed, at most one trailing line cut.
export const searchCommandOf = (line, cwd) => {
    const tokens = shellTokens(line.trim());
    if (tokens === undefined) {
        return undefined;
    }
    const segments = splitAt(tokens, "&&").map((segment) => splitAt(segment, "|").map(wordsOf));
    let dir = cwd;
    for (const stages of segments.slice(0, -1)) {
        const [words] = stages;
        if (stages.length !== 1 || words?.length !== 2 || words[0] !== "cd") {
            return undefined;
        }
        dir = resolve(dir, words[1]);
    }
    const stages = segments.at(-1) ?? [];
    const [words, cut] = stages;
    if (words === undefined || words.length === 0 || stages.length > 2 || (cut !== undefined && !isLineCut(cut))) {
        return undefined;
    }
    return { words, cwd: dir, piped: cut !== undefined };
};

// ---- Reading rg and grep's flags ---------------------------------------------------------------------------------------

// rg's flags this understands. `keep` narrows what is searched (kept in every probe), `drop` only shapes what is
// printed (each probe lists files), a role is read; anything else leaves the command unprobed.
const roled = (flags, role) => flags.split(" ").map((flag) => [flag, role]);
const RG_SWITCHES = new Map([
    ...roled("-i --ignore-case", "insensitive"),
    ...roled("-s --case-sensitive", "sensitive"),
    ...roled("-S --smart-case", "smart"),
    ...roled("-F --fixed-strings", "literal"),
    ...roled("--hidden -.", "hidden"),
    ...roled("--no-ignore", "noIgnore"),
    ...roled("-u", "unrestricted"),
    ...roled("-w --word-regexp -x --line-regexp -U --multiline --multiline-dotall -P --pcre2 -a --text -L --follow", "keep"),
    ...roled("--no-ignore-vcs --no-ignore-parent --no-ignore-dot --no-ignore-global --no-ignore-exclude --no-require-git", "keep"),
    ...roled("-n --line-number -N --no-line-number -H --with-filename -I --no-filename --heading --no-heading", "drop"),
    ...roled("-l --files-with-matches -c --count --count-matches -o --only-matching --column --vimgrep -p --pretty --trim", "drop"),
    ...roled("-0 --null --no-messages -b --byte-offset", "drop"),
]);
const RG_VALUED = new Map([
    ...roled("-e --regexp", "pattern"),
    ...roled("-g --glob --iglob -t --type -T --type-not --type-add -d --max-depth --max-filesize -E --encoding", "keep"),
    ...roled("-A --after-context -B --before-context -C --context -m --max-count -M --max-columns", "drop"),
    ...roled("--color --colors --sort --sortr -j --threads", "drop"),
]);

// GNU grep's, read the same way; a recursive flag is required.
const GREP_SWITCHES = new Map([
    ...roled("-r -R --recursive --dereference-recursive", "recursive"),
    ...roled("-i -y --ignore-case", "insensitive"),
    ...roled("--no-ignore-case", "sensitive"),
    ...roled("-F --fixed-strings", "literal"),
    ...roled("-w --word-regexp -x --line-regexp -E --extended-regexp -G --basic-regexp -P --perl-regexp -a --text -I", "keep"),
    ...roled("-n --line-number -H --with-filename -h --no-filename -l --files-with-matches -o --only-matching", "drop"),
    ...roled("-s --no-messages -b --byte-offset -T --initial-tab -Z --null --color --colour", "drop"),
]);
const GREP_VALUED = new Map([
    ...roled("-e --regexp", "pattern"),
    ...roled("--include --exclude --exclude-dir", "keep"),
    ...roled("-A --after-context -B --before-context -C --context -m --max-count", "drop"),
]);
// grep's flags whose value is optional, given only as `--flag=value`.
const OPTIONAL_VALUED = new Set(["--color", "--colour"]);

// One flag word as (flag, role, value?) entries: a long one with or without `=value`, a short cluster letter by letter
// (`-inC3`), the rest of a cluster after a valued letter being its value. Undefined for a flag not in the tables.
const flagEntries = (word, next, switches, valued) => (word.startsWith("--") ? longEntries(word, next, switches, valued) : shortEntries(word, next, switches, valued));

const longEntries = (word, next, switches, valued) => {
    const equals = word.indexOf("=");
    const flag = equals === -1 ? word : word.slice(0, equals);
    if (valued.has(flag) && equals !== -1) {
        return { entries: [{ flag, role: valued.get(flag), value: word.slice(equals + 1), joined: true }], used: 1 };
    }
    if (valued.has(flag)) {
        return next === undefined ? undefined : { entries: [{ flag, role: valued.get(flag), value: next }], used: 2 };
    }
    return switches.has(flag) && (equals === -1 || OPTIONAL_VALUED.has(flag)) ? { entries: [{ flag, role: switches.get(flag) }], used: 1 } : undefined;
};

const shortEntries = (word, next, switches, valued) => {
    const entries = [];
    for (let index = 1; index < word.length; index += 1) {
        const flag = `-${word[index]}`;
        if (valued.has(flag)) {
            const rest = word.slice(index + 1);
            const value = rest === "" ? next : rest;
            return value === undefined ? undefined : { entries: [...entries, { flag, role: valued.get(flag), value }], used: rest === "" ? 2 : 1 };
        }
        if (!switches.has(flag)) {
            return undefined;
        }
        entries.push({ flag, role: switches.get(flag) });
    }
    return { entries, used: 1 };
};

// The words after the program as flags and operands, or undefined for anything not in the tables.
const parsedArgs = (args, switches, valued) => {
    const entries = [];
    const operands = [];
    for (let index = 0; index < args.length; index += 1) {
        const word = args[index];
        if (word === "--") {
            operands.push(...args.slice(index + 1));
            break;
        }
        if (!word.startsWith("-") || word === "-") {
            operands.push(word);
            continue;
        }
        const read = flagEntries(word, args[index + 1], switches, valued);
        if (read === undefined) {
            return undefined;
        }
        entries.push(...read.entries);
        index += read.used - 1;
    }
    return { entries, operands };
};

// The flag words a probe keeps: everything but what only shapes output and the pattern itself.
const keptWords = (entries) =>
    entries.flatMap((entry) => {
        if (entry.role === "drop" || entry.role === "pattern") {
            return [];
        }
        if (entry.value === undefined) {
            return [entry.flag];
        }
        return entry.joined === true ? [`${entry.flag}=${entry.value}`] : [entry.flag, entry.value];
    });

// The case the search ran with: the last of -i, -s and -S wins, smart case reading the pattern.
const ignoredCase = (entries, pattern) => {
    const last = entries.findLast((entry) => entry.role === "insensitive" || entry.role === "sensitive" || entry.role === "smart")?.role;
    return last === "insensitive" || (last === "smart" && pattern === pattern.toLowerCase());
};

// A search as the probes need it: program, pattern, operands, kept flags and which switches it already had.
const searchOf = (program, args, switches, valued) => {
    const parsed = parsedArgs(args, switches, valued);
    const patterns = parsed?.entries.filter((entry) => entry.role === "pattern") ?? [];
    if (parsed === undefined || patterns.length > 1) {
        return undefined;
    }
    const pattern = patterns[0]?.value ?? parsed.operands[0];
    if (pattern === undefined || pattern === "") {
        return undefined;
    }
    const roles = new Set(parsed.entries.map((entry) => entry.role));
    const unrestricted = parsed.entries.filter((entry) => entry.role === "unrestricted").length;
    return {
        program,
        pattern,
        paths: patterns.length === 1 ? parsed.operands : parsed.operands.slice(1),
        kept: keptWords(parsed.entries),
        ignoreCase: ignoredCase(parsed.entries, pattern),
        literal: roles.has("literal"),
        recursive: roles.has("recursive"),
        hidden: roles.has("hidden") || unrestricted >= 2,
        noIgnore: roles.has("noIgnore") || unrestricted >= 1,
    };
};

// The search a command's words run, or undefined for anything but rg or a recursive grep this fully reads.
export const searchOfWords = (words) => {
    const [program, ...args] = words;
    if (program === "rg") {
        return searchOf("rg", args, RG_SWITCHES, RG_VALUED);
    }
    const grep = program === "grep" ? searchOf("grep", args, GREP_SWITCHES, GREP_VALUED) : undefined;
    return grep?.recursive === true ? grep : undefined;
};

// ---- Probing ------------------------------------------------------------------------------------------------------------

const PRUNE_GLOBS = PROBE_PRUNE_GLOBS.flatMap((glob) => ["-g", glob]);

// Each probe that could find what the search did not, as the flags it adds; grep -r already reads ignored and hidden
// files, so it has no third.
export const probesOf = (search) => {
    const probes = [];
    if (!search.ignoreCase && hasCase(search.pattern)) {
        probes.push({ kind: "case", before: [], after: ["-i"] });
    }
    if (search.program === "rg" && !(search.hidden && search.noIgnore)) {
        probes.push({ kind: "ignored", before: PRUNE_GLOBS, after: ["--no-ignore", "--hidden"] });
    }
    if (!search.literal && REGEX_SYNTAX.test(search.pattern)) {
        probes.push({ kind: "literal", before: [], after: ["-F"] });
    }
    return probes;
};

const said = (path) => (path.startsWith("./") ? path.slice(2) : path);

// One probe's files within what is left of the budget: rg or grep again, listing files, its stdin empty. rg is handed
// `./` when the search named no path, since with no path and a stdin that is not a terminal it reads the stdin.
const listed = (search, probe, cwd, deadline) => {
    const left = deadline - Date.now();
    if (left <= 0) {
        return undefined;
    }
    const paths = search.program === "rg" && search.paths.length === 0 ? ["./"] : search.paths;
    const args = [...probe.before, ...search.kept, ...probe.after, "-l", "-e", search.pattern, "--", ...paths];
    const run = spawnSync(search.program, args, {
        cwd,
        timeout: left,
        killSignal: "SIGKILL",
        encoding: "utf8",
        maxBuffer: LISTED_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
    });
    const found = (run.stdout ?? "").split("\n").filter((line) => line !== "").map(said);
    if (found.length === 0) {
        return undefined;
    }
    const more = run.error !== undefined || run.signal !== null || found.length > FILE_CAP;
    const files = found.slice(0, FILE_CAP).toSorted();
    return { kind: probe.kind, files: files.length, more, examples: files.slice(0, EXAMPLES) };
};

const probeSearch = (search, cwd, budgetMs = PROBE_BUDGET_MS) => {
    const deadline = Date.now() + budgetMs;
    return probesOf(search)
        .map((probe) => listed(search, probe, cwd, deadline))
        .filter((hit) => hit !== undefined);
};

// Whether the search itself found nothing: no output at all, and its own exit 1 (with a line cut, the pipeline's first
// status, since the exit code is the cut's).
const searchedEmpty = (raw, exitCode, pipeline, piped) => {
    if (raw.trim() !== "") {
        return false;
    }
    const statuses = pipeline.trim() === "" ? [] : pipeline.trim().split(/\s+/);
    return piped ? statuses.length === 2 && statuses[0] === "1" && statuses[1] === "0" : exitCode === "1" && statuses.length <= 1;
};

// The note for a shell search that found nothing, or undefined when the command is not one this reads, found
// something, or no probe matched.
export const emptySearchNote = (raw, { command, exitCode, pipeline = "", cwd = process.cwd(), budgetMs = PROBE_BUDGET_MS, enabled }) => {
    const line = enabled === undefined || enabled.has("probes") ? searchCommandOf(command, cwd) : undefined;
    const search = line === undefined ? undefined : searchOfWords(line.words);
    if (search === undefined || !searchedEmpty(raw, exitCode, pipeline, line.piped)) {
        return undefined;
    }
    const note = probeNote(probeSearch(search, line.cwd, budgetMs));
    return note === undefined ? undefined : `--- ${note}`;
};

// filterRun's one call: the filtered output with the note after it, weighed on the ledger as `probes`. Never throws.
export const withSearchProbes = (raw, filtered, options) => {
    let note;
    try {
        note = emptySearchNote(raw, options);
    } catch {
        // allow(silent-catch): the note is an addition to an empty result; one that cannot be made costs the note alone.
        note = undefined;
    }
    if (note === undefined) {
        return filtered;
    }
    const out = `${filtered.out === "" || filtered.out.endsWith("\n") ? filtered.out : `${filtered.out}\n`}${note}\n`;
    return { out, stages: [...filtered.stages, { id: "probes", saved: filtered.out.length - out.length }] };
};
