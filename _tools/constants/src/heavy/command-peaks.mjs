// (2026-11-22, the shinobi-society audit) WHICH COMMAND A QUEUED RUN IS, so the memory gate can price it at what the
// same command took last time (`learnedCostBytes` below; the daemon's system/resources/queue/command-peaks.ts keeps the peaks).
// The owner's table priced every cargo command there at 512 MiB (`size: targeted`), while `cargo test -p integra-render`
// ran a test binary that peaked at 7 to 13.5 GB: the gate admitted it beside other work, and the memory guard killed it.
//
// "The same command" is the rule that queued it, the repository and the folder in it it ran from, the program, and the
// words that decide how big it is. For cargo that is its subcommand and its package and target selectors (`-p`, `--lib`,
// `--test T`, `--workspace`, `--all-targets`, `--target`, the profile and the features), never a test filter, `-j`, or a
// path; for any other program it is all its words up to `--`. Never part of it: environment assignments, a `timeout`,
// `env`, `nice` or `time` in front, the queue's own wrappers (queue-run, heavy-launch.cjs, offload-run), redirections,
// and anything after a pipe or `;`. The repository is named by its git directory, never by the checkout's path, so every
// worktree of one repository shares a record. Plain JavaScript like memory-room, which runs it before any install.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const GIB = 1024 ** 3;
// How much of a line is read, and how long the words kept of it may grow.
const MAX_INPUT_WORDS = 64;
const MAX_WORDS = 16;
const MAX_CHARS = 240;

const CONTROL = new Set(["|", "||", "&&", ";", "&", "|&"]);
// A redirection (`2>&1`, `>out.log`, `</dev/null`), and one whose target is the next word (`> out.log`).
const REDIRECT = /^(?:\d*|&)(?:>>?|<<?|>&|<&|>\|)/u;
const BARE_REDIRECT = /^(?:\d*|&)(?:>>?|<<?|>\|)$/u;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
// Wrappers whose command follows their first `--`, run directly or by an interpreter (`bash …/queue-run`).
const WRAPPED_AFTER_SEPARATOR = new Set(["queue-run", "heavy-launch.cjs", "offload-run"]);
const INTERPRETERS = new Set(["bash", "sh", "node", "nodejs"]);
// Wrappers in front of the command, with the options of theirs that take a value.
const PREFIXES = new Map([
    ["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
    ["timeout", new Set(["-k", "--kill-after", "-s", "--signal"])],
    ["nice", new Set(["-n", "--adjustment"])],
    ["time", new Set(["-f", "--format", "-o", "--output"])],
    ["nohup", new Set()],
    ["command", new Set()],
    ["exec", new Set()],
]);

// One piece of a line: whitespace, a quoted run (its quotes dropped), a control operator, a lone `&`, or plain text.
const PIECE = /(\s+)|'([^']*)'?|"([^"]*)"?|(\|\||&&|\|&|[|;])|(&)|([^\s'"|;&]+)/gu;

/** A line's words as a shell splits them, roughly: whitespace apart, quotes kept together and removed, operators alone. */
export const lineWords = (line) => {
    const words = [];
    let word;
    const end = (operator) => {
        if (word !== undefined) {
            words.push(word);
        }
        word = undefined;
        if (operator !== undefined) {
            words.push(operator);
        }
    };
    for (const [, space, single, double, operator, ampersand, plain] of line.matchAll(PIECE)) {
        if (space !== undefined) {
            end();
        } else if (operator !== undefined || (ampersand !== undefined && !/[<>]$/u.test(word ?? ""))) {
            // `2>&1` keeps its `&`; anywhere else it is an operator.
            end(operator ?? ampersand);
        } else {
            word = (word ?? "") + (single ?? double ?? ampersand ?? plain);
        }
    }
    end();
    return words.slice(0, MAX_INPUT_WORDS);
};

// The words with redirections and everything from the first control operator on taken out.
const commandOnly = (words) => {
    const kept = [];
    for (let at = 0; at < words.length; at += 1) {
        const word = words[at];
        if (CONTROL.has(word)) {
            break;
        }
        if (REDIRECT.test(word)) {
            at += BARE_REDIRECT.test(word) ? 1 : 0;
            continue;
        }
        kept.push(word);
    }
    return kept;
};

// The words past one wrapper in front, or undefined when the first word is none.
const unwrapOnce = (words) => {
    const first = basename(words[0] ?? "");
    if (ASSIGNMENT.test(words[0] ?? "")) {
        return words.slice(1);
    }
    const wrapper = WRAPPED_AFTER_SEPARATOR.has(first) ? 0 : INTERPRETERS.has(first) && WRAPPED_AFTER_SEPARATOR.has(basename(words[1] ?? "")) ? 1 : -1;
    if (wrapper >= 0) {
        const separator = words.indexOf("--", wrapper + 1);
        return separator === -1 ? [] : words.slice(separator + 1);
    }
    const valued = PREFIXES.get(first);
    if (valued === undefined) {
        return undefined;
    }
    // `env` also takes the assignments it sets before the command.
    const ownWord = first === "env" ? (word) => word.startsWith("-") || ASSIGNMENT.test(word) : (word) => word.startsWith("-");
    let at = 1;
    while (at < words.length && ownWord(words[at])) {
        at += valued.has(words[at]) ? 2 : 1;
    }
    // `timeout` takes its duration before the command.
    return words.slice(first === "timeout" ? at + 1 : at);
};

// Cargo's flags that decide what it builds, with the one spelling each is kept under; and the global options before the
// subcommand that take a value (`cargo --config k=v test`).
const CARGO_VALUED = new Map([
    ["-p", "-p"],
    ["--package", "-p"],
    ["--exclude", "--exclude"],
    ["--bin", "--bin"],
    ["--test", "--test"],
    ["--example", "--example"],
    ["--bench", "--bench"],
    ["--target", "--target"],
    ["--profile", "--profile"],
    ["--features", "--features"],
    ["-F", "--features"],
]);
const CARGO_SWITCHES = new Map([
    ["--workspace", "--workspace"],
    ["--all", "--workspace"],
    ["--lib", "--lib"],
    ["--bins", "--bins"],
    ["--tests", "--tests"],
    ["--examples", "--examples"],
    ["--benches", "--benches"],
    ["--all-targets", "--all-targets"],
    ["--doc", "--doc"],
    ["--release", "--release"],
    ["-r", "--release"],
    ["--all-features", "--all-features"],
    ["--no-default-features", "--no-default-features"],
]);
const CARGO_GLOBAL_VALUED = new Set(["--config", "-Z", "-C", "--color"]);

// One cargo argument as a selector (`-p x`, `--lib`), or undefined for any other; `next` is the word after it.
const cargoSelector = (word, next) => {
    const [flag, inline] = word.startsWith("--") && word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined];
    if (CARGO_SWITCHES.has(flag) && inline === undefined) {
        return { words: CARGO_SWITCHES.get(flag), used: 1 };
    }
    if (CARGO_VALUED.has(flag)) {
        return inline === undefined ? { words: `${CARGO_VALUED.get(flag)} ${next ?? ""}`.trim(), used: 2 } : { words: `${CARGO_VALUED.get(flag)} ${inline}`, used: 1 };
    }
    const glued = /^-([pF])(.+)$/u.exec(word);
    return glued === null ? undefined : { words: `${CARGO_VALUED.get(`-${glued[1]}`)} ${glued[2]}`, used: 1 };
};

const cargoWords = (args) => {
    let at = 0;
    while (at < args.length && (args[at].startsWith("+") || args[at].startsWith("-"))) {
        at += CARGO_GLOBAL_VALUED.has(args[at]) ? 2 : 1;
    }
    const subcommand = args[at];
    if (subcommand === undefined) {
        return "cargo";
    }
    const selectors = new Set();
    for (at += 1; at < args.length && args[at] !== "--"; ) {
        const selector = cargoSelector(args[at], args[at + 1]);
        if (selector === undefined) {
            at += 1;
            continue;
        }
        selectors.add(selector.words);
        at += selector.used;
    }
    return ["cargo", subcommand, ...[...selectors].toSorted()].join(" ");
};

/**
 * The words that say which command `argv` is (a line's words from `lineWords`, or a process's argv): its program and what
 * decides its size, with the wrappers, environment, redirections, pipes and test filters taken out, and a path under
 * `root` (the checkout it ran in) made relative to it. Undefined where no program is left.
 */
export const commandWords = (argv, root) => {
    let words = commandOnly(argv.slice(0, MAX_INPUT_WORDS));
    for (let unwrapped = unwrapOnce(words); unwrapped !== undefined && words.length > 0; unwrapped = unwrapOnce(words)) {
        words = unwrapped;
    }
    if (words.length === 0 || words[0] === "") {
        return undefined;
    }
    const program = basename(words[0]);
    const args = words.slice(1);
    if (program === "cargo") {
        return cargoWords(args).slice(0, MAX_CHARS);
    }
    const separator = args.indexOf("--");
    const inRoot = (word) => (root !== undefined && isAbsolute(word) && word.startsWith(`${root}/`) ? relative(root, word) : word);
    return [program, ...(separator === -1 ? args : args.slice(0, separator)).map(inRoot)].slice(0, MAX_WORDS).join(" ").slice(0, MAX_CHARS);
};

const readText = (path) => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        // allow(silent-catch): a pointer that cannot be read names no repository; the checkout's own name stands in
        return undefined;
    }
};

const kindOf = (path) => {
    try {
        const stat = statSync(path);
        return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : undefined;
    } catch {
        // allow(silent-catch): no `.git` here is the ordinary case on the way up
        return undefined;
    }
};

// The repository a `.git` belongs to, by its common git directory: `/work/x/.git` is x, a worktree's pointer into
// `/history/gits/x/worktrees/y` (whose `commondir` leads back up) is x too, and so is a bare `x.git`.
const repositoryOf = (dotGit, kind) => {
    let common = dotGit;
    if (kind === "file") {
        const pointer = /^gitdir:\s*(.+)$/mu.exec(readText(dotGit) ?? "")?.[1]?.trim();
        if (pointer === undefined || pointer === "") {
            return undefined;
        }
        const gitDir = resolve(dirname(dotGit), pointer);
        const commonDir = readText(join(gitDir, "commondir"))?.trim();
        common = commonDir === undefined || commonDir === "" ? gitDir : resolve(gitDir, commonDir);
    }
    const name = basename(common);
    return name === ".git" ? basename(dirname(common)) : name.replace(/\.git$/u, "");
};

/** The checkout `cwd` is in: its repository's name, its root, and `cwd` relative to that root; undefined outside one. */
export const checkoutOf = (cwd) => {
    const here = resolve(cwd);
    for (let dir = here; ; dir = dirname(dir)) {
        const dotGit = join(dir, ".git");
        const kind = kindOf(dotGit);
        if (kind !== undefined) {
            return { repo: repositoryOf(dotGit, kind) ?? basename(dir), root: dir, dir: relative(dir, here) };
        }
        if (dirname(dir) === dir) {
            return undefined;
        }
    }
};

/**
 * The record a queued command's peak is kept under (`key`) and the words it is named by (`command`): `rule @repo/dir:
 * words`, the rule being the heavy-command rule that queued it.
 */
export const commandSignature = ({ rule, command, cwd }) => {
    const checkout = cwd === undefined ? undefined : checkoutOf(cwd);
    const words = commandWords(command, checkout?.root);
    if (words === undefined) {
        return undefined;
    }
    const where = checkout === undefined ? "" : checkout.dir === "" ? checkout.repo : `${checkout.repo}/${checkout.dir}`;
    return { key: `${rule} @${where}: ${words}`, command: words };
};

// (2026-11-25, the shinobi-society audit) WHICH LINE AN AGENT RAN, for a command that grew heavy without going through the
// queue (a `python3 tools/gen.py` at 3.5 GiB, the repository's own binaries at 2.4 GiB, a game at 1.4 GiB, all priced at
// nothing). Such a line is no program a rule names, so it is named by the whole line: every command of it as
// `commandWords` names one, joined by the operators between them, under LEARNED_RULE. A leading `cd DIR` is where it ran,
// not a command; a filter a pipe feeds (`| tail -40`) and a builtin that starts nothing are no part of it; a heredoc is
// named by a hash of its body, so two scripts fed to `python3 -` are two commands. The daemon records such a line's peak
// beside the queued ones and queues its next run (the daemon's system/resources/queue/unqueued-peaks.ts, learned-lines.ts).
export const LEARNED_RULE = "learned";
// The least such a line must have held, outside the queue or in it lately, for its next run to queue.
export const LEARNED_MIN_BYTES = GIB;
const PIPE_FILTERS = new Set(["tail", "head", "tee", "grep", "rg", "cat", "wc", "sort", "uniq", "cut", "sed", "awk", "jq", "tr", "less", "more", "column"]);
const NO_COMMAND = new Set(["cd", "echo", "printf", "true", "false", "export", "set", "unset", "sleep", ":", "pwd", "wait"]);
// A heredoc's opener (`<<'EOF'`, `<<-EOF`), what follows it on its line, its body and its terminator line.
const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_][\w.-]*)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/gu;

// The line with each heredoc body replaced by a word naming it, continuations joined, and its lines separated by `;`.
const flatLine = (line) =>
    line
        .replaceAll(HEREDOC, (_whole, _quote, _tag, rest, body) => ` heredoc:${createHash("sha256").update(body).digest("hex").slice(0, 10)}${rest}`)
        .replaceAll("\\\n", " ")
        .replaceAll("\n", " ; ");

// The line's commands, each with the operator before it (undefined for the first).
const segmentsOf = (words) => {
    const segments = [{ operator: undefined, words: [] }];
    for (const word of words) {
        if (CONTROL.has(word)) {
            segments.push({ operator: word, words: [] });
        } else {
            segments.at(-1).words.push(word);
        }
    }
    return segments.filter((segment) => segment.words.length > 0);
};

// Where a `cd` segment moves the line to; undefined for any other segment, and for a `cd` that cannot be followed
// (`cd -`, `cd ~/x`, `cd` alone, or a line with no known start).
const movedTo = (segment, where) => {
    const target = segment.words[1];
    return basename(segment.words[0]) !== "cd" || segment.words.length !== 2 || where === undefined || target.startsWith("~") || target === "-"
        ? undefined
        : resolve(where, target);
};

const isCommand = (segment) => {
    const program = basename(segment.words[0]);
    return !NO_COMMAND.has(program) && !(segment.operator === "|" && PIPE_FILTERS.has(program));
};

const placeOf = (cwd) => {
    const checkout = cwd === undefined ? undefined : checkoutOf(cwd);
    return checkout === undefined ? "" : checkout.dir === "" ? checkout.repo : `${checkout.repo}/${checkout.dir}`;
};

/**
 * The record an agent's whole line is kept under, and the words it is named by: `learned @repo/dir: words`. `cwd` is
 * where the line starts; a leading `cd` moves it. Undefined for a line that names no command.
 */
export const lineSignature = (line, cwd) => {
    const parts = [];
    let where = cwd;
    let first;
    for (const segment of segmentsOf(lineWords(flatLine(line.slice(0, 4096))))) {
        const moved = movedTo(segment, where);
        where = moved ?? where;
        const named = moved === undefined && isCommand(segment) ? commandWords(segment.words, where === undefined ? undefined : checkoutOf(where)?.root) : undefined;
        if (named !== undefined) {
            first ??= where;
            parts.push(parts.length === 0 ? named : `${segment.operator} ${named}`);
        }
    }
    if (parts.length === 0) {
        return undefined;
    }
    const command = parts.join(" ").slice(0, MAX_CHARS);
    return { key: `${LEARNED_RULE} @${placeOf(first)}: ${command}`, command };
};

/** The command a queue-run process runs, from its argv (bash, queue-run, its flags, `--`, the command); undefined for any other. */
export const queuedCommand = (argv) => {
    const at = argv.findIndex((word) => basename(word) === "queue-run");
    const separator = at === -1 ? -1 : argv.indexOf("--", at + 1);
    return separator === -1 || separator === argv.length - 1 ? undefined : argv.slice(separator + 1);
};

/** A process's start, in clock ticks since boot, from its /proc stat: the same in every pid namespace it is seen from. */
export const startTicksOf = (stat) => {
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : undefined;
};

/**
 * The signature of the command queue-run process `pid` runs (what memory-room asks the daemon to price it by), with that
 * process's start, so the daemon can find it again in its own pid namespace. Undefined for anything it cannot read.
 */
export const queuedSignature = (pid, rule, { proc = "/proc", cwd } = {}) => {
    try {
        const cmdline = readText(`${proc}/${pid}/cmdline`);
        const stat = readText(`${proc}/${pid}/stat`);
        const command = cmdline === undefined ? undefined : queuedCommand(cmdline.split("\0").filter((word, at, all) => word !== "" || at < all.length - 1));
        const start = stat === undefined ? undefined : startTicksOf(stat);
        const signature = command === undefined || start === undefined ? undefined : commandSignature({ rule, command, cwd: cwd ?? process.cwd() });
        return signature === undefined ? undefined : { ...signature, start };
    } catch {
        // allow(silent-catch): a command that cannot be named (a working directory deleted under it) is priced by its rule
        return undefined;
    }
};

/**
 * A signature named outright (`memory-room --key K --command C`, which queue-run passes for an agent's line queued by
 * what it took last time: its argv is `bash <run dir>/agent`, which names nothing), with the start of queue-run process
 * `pid`. Undefined where either is missing or the process cannot be read.
 */
export const namedSignature = (pid, key, command, { proc = "/proc" } = {}) => {
    const fits = (text) => text !== undefined && text !== "" && text.length <= 600;
    const stat = fits(key) && fits(command) ? readText(`${proc}/${pid}/stat`) : undefined;
    const start = stat === undefined ? undefined : startTicksOf(stat);
    return start === undefined ? undefined : { key, command, start };
};

// (2026-11-22, the shinobi-society audit) A COMMAND IS PRICED AT LEAST AT WHAT IT TOOK LAST TIME. A rule's price is a
// guess by name: the owner's table priced every cargo command at 512 MiB (`targeted`), and `cargo test -p integra-render`
// then ran a test binary that peaked at 7 to 13.5 GB, was admitted beside other work, and was killed by the memory guard,
// again and again. The daemon measures what each queued command's process tree held at its peak
// (system/resources/queue/peak-watch.ts) and keeps the last few runs of each command (the signature above says which
// runs are one command), and the next run is priced at the larger of its rule's price and that peak with PEAK_MARGIN on
// top: a margin, since one run's peak is not the most the command can take. Capped at `limitBytes`, what the sandbox
// could ever hold, so one outlier never makes a command unrunnable: priced above what is free, it waits as any large
// command does. A command never measured, and a smaller peak than its rule's price, leave the price as it was.
export const PEAK_MARGIN = 1.15;

/** What a toolchain command is priced at: its rule's `configuredBytes`, or its learned `peakBytes` with the margin where that is more. */
export const learnedCostBytes = (configuredBytes, peakBytes, limitBytes) =>
    peakBytes === undefined || !(peakBytes > 0)
        ? configuredBytes
        : Math.max(configuredBytes, Math.min(Math.ceil(peakBytes * PEAK_MARGIN), limitBytes ?? Number.POSITIVE_INFINITY));


const gib = (bytes) => `${(bytes / GIB).toFixed(1)} GiB`;

/** Why a command is priced above its rule's price: `` `cargo test -p x` peaked at 9.7 GiB on its last run ``. */
export const peakWords = (priced) =>
    `\`${priced.command}\` peaked at ${gib(priced.peakBytes)} ${priced.runs > 1 ? `over its last ${priced.runs} runs` : "on its last run"}`;

/** The sentence a wait line ends with for a command priced by its peak, or "" for one priced by its rule. */
export const pricedWords = (priced) => (priced === undefined ? "" : ` Priced at ${gib(priced.bytes)}: ${peakWords(priced)}.`);
