// The output-cleaner registry behind agent-output-filter. Each cleaner has a stable `id`; the active set is a
// spec (INTENTIC_OUTPUT_CLEANERS) parsed the same way as iq's --features (allow-list / default-minus), so
// cleaners can be flipped on/off and A/B benchmarked exactly like iq's retrieval stages. Plain .mjs (no build
// step) — imported by agent-output-filter and unit tests. Kept dependency-free (node builtins only) so the
// filter never breaks.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// CSI sequences, OSC sequences (title sets, hyperlinks), and lone two-byte escapes. Always stripped (pure noise).
// eslint-disable-next-line no-control-regex
export const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

// A spinner/progress bar redraws one line with \r — keep only the final frame. Always applied (pure noise).
export const collapseCr = (line) => {
    const frames = line.split("\r");
    for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i] !== "") {
            return frames[i];
        }
    }
    return "";
};

// Success-path per-command noise strippers. Narrow patterns — a false command match strips nothing real.
const strip = (id, match, patterns) => ({
    id,
    match,
    apply: (lines) => lines.filter((line) => !patterns.some((re) => re.test(line))),
});

// What a line array would weigh once joined with newlines — measured without building the string, because the
// pipeline measures it after EVERY stage and materialising a 500k-line capture per stage would cost more than
// the cleaning does.
export const bodyBytes = (lines) => (lines.length === 0 ? 0 : lines.reduce((sum, line) => sum + line.length, 0) + lines.length - 1);

// ---- shape cleaners: they read the output, not the command -------------------------------------------------
// A command regex cannot see past `cd x && …`, and four out of five of an agent's commands are written that
// way. So the two shapes carrying the most bytes are recognised in the TEXT instead. Each self-gates on what it
// recognises and hands back the lines it was given when it recognises nothing, which is what makes it safe to
// run on every success rather than behind a command match.

const humanSize = (bytes) =>
    bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)}M` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}K` : `${bytes}B`;

// `-rwsr-xr-t` → `4755`. `s`/`t` mean the special bit AND execute, `S`/`T` the special bit alone; the leading
// digit is emitted only when one is set, so the overwhelmingly common case stays three characters.
const EXECUTABLE = new Set(["x", "s", "t"]);
const permsToOctal = (perms) => {
    const triad = (read, write, exec) => (perms[read] === "r" ? 4 : 0) + (perms[write] === "w" ? 2 : 0) + (EXECUTABLE.has(perms[exec]) ? 1 : 0);
    const special = ("sS".includes(perms[3]) ? 4 : 0) + ("sS".includes(perms[6]) ? 2 : 0) + ("tT".includes(perms[9]) ? 1 : 0);
    const mode = `${triad(1, 2, 3)}${triad(4, 5, 6)}${triad(7, 8, 9)}`;
    return special > 0 ? `${special}${mode}` : mode;
};

// The date is the anchor, not a column index: an owner or group name containing a space shifts every column
// left of the name and `ls` has no quoting to recover it from. Both GNU spellings are matched — the default
// `Mon DD HH:MM` / `Mon DD  YYYY`, and `--time-style=long-iso`.
const LS_DATE = /\s(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(?:\d{4}|\d{1,2}:\d{2})|\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})\s/;
const LS_MODE = /^[-dlbcps][rwxSsTt-]{9}[.+@]?$/;

const parseListingLine = (line) => {
    const date = LS_DATE.exec(line);
    if (date === null) {
        return undefined;
    }
    const head = line
        .slice(0, date.index)
        .split(/\s+/)
        .filter((token) => token !== "");
    if (head.length < 4 || !LS_MODE.test(head[0])) {
        return undefined;
    }
    // Size is the RIGHTMOST integer before the date: the link count is numeric too but comes first, and a device
    // node's `166, 0` is no integer at all — those entries keep their name and lose only the size.
    const size = head.reduceRight((found, token) => (found === undefined && /^\d+$/.test(token) ? Number(token) : found), undefined);
    return { mode: permsToOctal(head[0]), directory: head[0].startsWith("d"), size, name: line.slice(date.index + date[0].length) };
};

// `ls -l` spends ~50 bytes per entry on a link count, owner, group and timestamp the model asked nothing about.
// Rewrite each entry to `<octal> <name>[/]  <size>`, drop the `total N` header and the `.`/`..` entries. Entry
// ORDER is preserved — rtk sorts directories first, which it can afford because it re-runs `ls` itself; we only
// see the output, and reordering it would silently destroy the answer to `ls -lt`.
const compactListing = (lines) => {
    let parsed = 0;
    const out = lines.flatMap((line) => {
        if (/^total \d+$/.test(line)) {
            return [];
        }
        const entry = parseListingLine(line);
        if (entry === undefined) {
            return [line];
        }
        parsed++;
        if (entry.name === "." || entry.name === "..") {
            return [];
        }
        if (entry.directory) {
            return [`${entry.mode} ${entry.name}/`];
        }
        return [`${entry.mode} ${entry.name}${entry.size === undefined ? "" : `  ${humanSize(entry.size)}`}`];
    });
    // Nothing recognised — a non-English locale, or not a listing at all. Hand back exactly what came in.
    return parsed === 0 ? lines : out;
};

// A run of bare paths is what `find`, `git ls-files`, `rg -l` and `ls -R | …` all emit, and a repo-wide run is
// thousands of lines whose directory prefix repeats on nearly every one. Fold each run to one line per
// directory: every NAME survives, only the repetition goes.
const PATH_RUN_MIN = 10;
const PATH_RUN_DIRS = 60;
const PATH_RUN_NAMES = 40;

// No whitespace (a listing line has plenty), no `:<digit>` (that is a `file:line:` diagnostic, not a path), and
// nothing absurdly long. Deliberately strict: a run this misreads is a run folded into the wrong shape.
const isPathLine = (line) => line !== "" && !/\s/.test(line) && !/:\d/.test(line) && line.length < 300;

// The longest directory prefix every entry shares — a repo-wide `find` repeats it on all 393 lines, and it is
// the single biggest thing in the output. Trimmed one whole segment at a time so the result is always a real
// directory, never a truncated name.
const sharedRoot = (directories) => {
    if (directories.length < 2) {
        return "";
    }
    let prefix = directories[0];
    for (const directory of directories) {
        while (prefix !== "" && !directory.startsWith(prefix)) {
            const shorter = prefix.slice(0, prefix.lastIndexOf("/", prefix.length - 2) + 1);
            // "/" has no shorter form to fall back to, and lastIndexOf would keep handing it back — a run mixing
            // absolute and relative paths shares no root at all, and says so by terminating here.
            prefix = shorter === prefix ? "" : shorter;
        }
    }
    return prefix;
};

const foldPaths = (run) => {
    // A run of loose words is not a path list — real `find` output is dominated by lines carrying a directory.
    if (run.filter((line) => line.includes("/")).length * 5 < run.length * 3) {
        return run;
    }
    const byDirectory = new Map();
    for (const path of run) {
        const cut = path.lastIndexOf("/");
        const directory = cut === -1 ? "./" : path.slice(0, cut + 1);
        const names = byDirectory.get(directory);
        if (names === undefined) {
            byDirectory.set(directory, [path.slice(cut + 1)]);
        } else {
            names.push(path.slice(cut + 1));
        }
    }
    // Below a segment or so the header costs more than the repetition it replaces, so the root stays inline.
    const root = sharedRoot([...byDirectory.keys()]);
    const trim = root.length > 8 ? root.length : 0;
    const folded = [`${run.length} paths in ${byDirectory.size} directories${trim === 0 ? "" : ` under ${root}`}:`];
    let shown = 0;
    for (const [directory, names] of [...byDirectory].slice(0, PATH_RUN_DIRS)) {
        const kept = names.slice(0, PATH_RUN_NAMES);
        shown += kept.length;
        folded.push(`${directory.slice(trim) === "" ? "./" : directory.slice(trim)} ${kept.join(" ")}`);
    }
    if (shown < run.length) {
        folded.push(`… ${run.length - shown} more paths elided`);
    }
    // One directory of long names can fold to more than it replaced; then the fold is simply not taken.
    return bodyBytes(folded) < bodyBytes(run) ? folded : run;
};

const foldPathRuns = (lines) => {
    const out = [];
    for (let i = 0; i < lines.length;) {
        let j = i;
        while (j < lines.length && isPathLine(lines[j])) {
            j++;
        }
        if (j === i) {
            out.push(lines[i]);
            i++;
            continue;
        }
        out.push(...(j - i >= PATH_RUN_MIN ? foldPaths(lines.slice(i, j)) : lines.slice(i, j)));
        i = j;
    }
    return out;
};

// The registry: command-scoped cleaners (id ↔ command regex ↔ transform) and shape cleaners (no `match`, so
// they are offered on every success and gate themselves on the text). Composable — every enabled cleaner that
// applies runs, in array order.
//
// The strippers here are the ones a replay of 10,682 real agent commands showed removing bytes. The eight that
// removed exactly zero over that corpus (npm, yarn, docker, git, pip, lint, gh, build) are gone: a stripper
// that fires constantly and removes nothing is registry surface with a maintenance cost, a switch on the
// settings page and no payer. Adding one back is three lines — `discover` says when a corpus asks for it.
const COMMAND_CLEANERS = [
    strip("pnpm", /\bpnpm\b/, [
        /^\s*Progress: /,
        /^Packages: [+-]/,
        /^Downloading /,
        /^\s*[.+]+\s*$/,
        /^Virtual store is at/,
        /^Lockfile is up to date/,
    ]),
    strip("apt", /\bapt(?:-get)?\b/, [/^(?:Get:|Hit:|Ign:|Fetched |Selecting |Preparing to unpack|Unpacking |Setting up |Processing triggers)/]),
    // Test runners: on a green run (this only fires on exit 0) the per-test PASS lines are noise — drop them and
    // keep the summary. Failures (exit ≠ 0) skip all command cleaners, so failing tests survive verbatim.
    strip("test", /\b(?:vitest|jest|pytest|rspec|mocha|phpunit)\b|\bgo test\b|\bcargo test\b/, [
        /^\s*[✓√]\s/, // per-test pass (vitest/jest/mocha)
        /^--- PASS:/, // go test per-test
        /^\s*test .+\.\.\. ok$/, // cargo test per-test
        /^PASS\s+\S/, // jest per-file PASS header
        /^\s*[.·]+\s*$/, // pytest/mocha dot progress
    ]),
    { id: "ls", apply: compactListing },
    { id: "files", apply: foldPathRuns },
];

// The full toggle vocabulary: every registry cleaner id, plus the global stages. `dedup` and `redact` run on all
// output; `cap` is the head/tail truncation; `cache` collapses a command whose output is byte-identical to an
// earlier run this session (applied in agent-output-filter, which owns the store).
export const CLEANERS = [...COMMAND_CLEANERS.map((cleaner) => cleaner.id), "dedup", "cap", "redact", "cache"];

// Collapse a run of ≥3 identical consecutive lines to one line + a count marker. Lossless on distinct content —
// only repetition is dropped — so it's safe on both success output and repeated failure lines (looping traces).
const dedupeRuns = (lines) => {
    const out = [];
    for (let i = 0; i < lines.length;) {
        let j = i + 1;
        while (j < lines.length && lines[j] === lines[i]) {
            j++;
        }
        const run = j - i;
        out.push(lines[i]);
        if (run >= 3) {
            out.push(`  … (${run - 1} more identical lines)`);
        } else {
            for (let k = 1; k < run; k++) {
                out.push(lines[i]);
            }
        }
        i = j;
    }
    return out;
};

// Mask common secret shapes before output reaches the model — defense-in-depth for an autonomous agent that
// might echo env/config. Conservative: only secret-named assignments, AWS access keys, bearer tokens, URL creds.
const SECRET_PATTERNS = [
    [/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*\s*[:=]\s*)(\S+)/gi, "$1***"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "***"],
    [/\b(Bearer\s+)[\w.-]+/gi, "$1***"],
    [/\b(https?:\/\/[^:@\s/]+:)[^@\s]+@/gi, "$1***@"],
];
const redactLine = (line) => SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), line);

// Parse the spec into the enabled set. Same grammar as iq's parseFeatures — allow-list if any token lacks "-"
// ("git,pnpm" = only those), else default-minus ("-git" = all except). Empty/undefined = all on. UNLIKE iq's
// version this is LENIENT: unknown tokens are ignored rather than thrown, because the filter must never break a
// tool result over a typo'd setting (the daemon owns validation of what it writes).
export const parseCleaners = (spec) => {
    if (spec === undefined || spec.trim() === "") {
        return new Set(CLEANERS);
    }
    const tokens = spec
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token !== "" && CLEANERS.includes(token.replace(/^-/, "")));
    if (tokens.length === 0) {
        return new Set(CLEANERS);
    }
    const allowList = tokens.some((token) => !token.startsWith("-"));
    if (allowList) {
        return new Set(tokens.filter((token) => !token.startsWith("-")));
    }
    const disabled = new Set(tokens.map((token) => token.slice(1)));
    return new Set(CLEANERS.filter((cleaner) => !disabled.has(cleaner)));
};

// Generic success cap (any command): outputs past MAX keep the first HEAD + last TAIL lines. Failures keep
// everything up to FAIL_TAIL — errors usually live at the end.
const HEAD = 30;
const TAIL = 50;
const MAX = 100;
const FAIL_TAIL = 500;

// The gated cleaning pipeline over already-split, ANSI/\r-cleaned lines. Exit-code-asymmetric: on success run the
// matching command cleaners then the cap; on failure keep everything but a generous tail. `enabled` gates each id.
//
// Returns the cleaned lines AND what each stage removed, in pipeline order — the per-mechanism attribution the
// savings report is built on. It is sequential by construction (each stage is weighed against what reached it,
// not against the raw capture), which is what makes the stages sum exactly to the total saving and lets them be
// drawn as one stacked bar. The flip side, and the reason the UI must not label these "what turning this off
// would save": a cleaner that runs before the cap is credited with lines the cap would have taken anyway.
export const cleanLines = (lines, { command, exitCode, enabled }) => {
    const stages = [];
    let out = lines;
    let bytes = bodyBytes(lines);
    // Weigh the result of one stage against what reached it, and record the difference under the stage's id.
    // A stage that changed nothing still costs one pass; recording it (at 0) is what lets the report say a
    // cleaner fired and was worth nothing, which is a different fact from it never having run.
    const ran = (id, next) => {
        out = next;
        const after = bodyBytes(out);
        stages.push({ id, saved: bytes - after });
        bytes = after;
    };
    if (exitCode === "0") {
        for (const cleaner of COMMAND_CLEANERS) {
            // A shape cleaner has no `match`: it is offered every command and decides from the text itself.
            if (enabled.has(cleaner.id) && (cleaner.match === undefined || cleaner.match.test(command))) {
                ran(cleaner.id, cleaner.apply(out));
            }
        }
        if (enabled.has("dedup")) {
            ran("dedup", dedupeRuns(out));
        }
        if (enabled.has("cap") && out.length > MAX) {
            ran("cap", [...out.slice(0, HEAD), `… ${out.length - HEAD - TAIL} lines elided …`, ...out.slice(-TAIL)]);
        }
    } else {
        // Failures keep detail verbatim — only collapse long identical runs (lossless) and cap at a generous tail.
        if (enabled.has("dedup")) {
            ran("dedup", dedupeRuns(out));
        }
        if (out.length > FAIL_TAIL) {
            // Its own id, never folded into `cap`: this one is unconditional (errors are kept whatever the
            // spec says), so crediting the `cap` toggle with it would put a number under a switch that did not
            // produce it.
            ran("failtail", [`… ${out.length - FAIL_TAIL} earlier lines elided …`, ...out.slice(-FAIL_TAIL)]);
        }
    }
    // Redaction runs last on both paths so a leaked secret is masked even inside an error dump.
    if (enabled.has("redact")) {
        ran("redact", out.map(redactLine));
    }
    return { lines: out, stages };
};

// Which cleaners CLAIMED this command — recorded in filter-stats.jsonl, and the question `gaps` is built on
// ("high-volume commands no handler claimed ⇒ where to write the next one"). Command-scoped only: a shape
// cleaner claims nothing in advance, it decides from the output, so counting it here would make every command
// look handled and empty the gaps list. What the shape cleaners were worth is in `stageBytes`.
export const matchedCleaners = (command, enabled) =>
    COMMAND_CLEANERS.filter((cleaner) => cleaner.match !== undefined && enabled.has(cleaner.id) && cleaner.match.test(command)).map(
        (cleaner) => cleaner.id,
    );

// ---- `cache` cleaner: collapse a byte-identical repeat of a command's output within one agent session ----
// Agents re-run the same command (git status, pnpm test, tsc) across a turn; when the cleaned output is identical
// to a previous run this session, the second one carries no new information. Replace it with a one-liner that
// points at the reversible retrieval handle — the boost "result cache" idea applied to output tokens. Stateful,
// so it lives here (agent-output-filter owns the store) rather than in the pure cleanLines pipeline.

// Sentinel the collapse emits; agent-output-filter recognises it to record `cache` in the stat line's `matched`.
export const CACHE_MARKER = "(output identical to a previous run this session";

const hashText = (text) => createHash("sha1").update(text).digest("hex");

// The per-session key: every command in one SDK session runs in a new tmux window (new pane id), so the pane-log
// path differs per command — strip the trailing `-<pane>.log` to recover the shared `agent-<id>` session name.
// undefined ⇒ no stable key (the cache then never hits, which is the safe/fail-open outcome).
export const sessionKeyFromLog = (logPath) => {
    if (logPath === undefined || logPath === "") {
        return undefined;
    }
    const base = logPath.split("/").pop() ?? "";
    const match = base.match(/^(.*)-[^-]+\.log$/);
    return match !== null && match[1] !== "" ? match[1] : undefined;
};

// A file-backed store of commandHash → bodyHash under <terminalsDir>/../output-cache/<sessionKey>.json. Read once,
// rewritten on each miss. Fail-open on any I/O error (a missed collapse never breaks the tool result).
export const openCacheStore = (terminalsDir, sessionKey) => {
    const file = join(terminalsDir, "..", "output-cache", `${sessionKey}.json`);
    let map;
    try {
        map = new Map(Object.entries(JSON.parse(readFileSync(file, "utf8"))));
    } catch {
        map = new Map();
    }
    return {
        lookup: (key) => map.get(key),
        record: (key, value) => {
            map.set(key, value);
            try {
                mkdirSync(dirname(file), { recursive: true });
                writeFileSync(file, JSON.stringify(Object.fromEntries(map)));
            } catch {
                // best-effort: a failed write just means the next identical run won't collapse.
            }
        },
    };
};

// Pure given `store` (an object with lookup/record): on a hit return the collapse marker, else record and pass the
// body through. Tests inject an in-memory Map-backed store to stay deterministic.
export const collapseCached = (body, command, store, logPath) => {
    const commandHash = hashText(command);
    const bodyHash = hashText(body);
    if (store.lookup(commandHash) === bodyHash) {
        const handle = logPath !== undefined && logPath !== "" ? ` · retrieve-output ${logPath}` : "";
        return { body: `${CACHE_MARKER}${handle})`, cached: true };
    }
    store.record(commandHash, bodyHash);
    return { body, cached: false };
};
