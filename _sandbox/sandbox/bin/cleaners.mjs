// Output-cleaner registry behind agent-output-filter. Each cleaner has a stable `id`; the active set is controlled by
// the INTENTIC_OUTPUT_CLEANERS spec (allow-list / default-minus). Dependency-free (node builtins only) so the filter
// never breaks; imported by agent-output-filter and its tests.

import { createHash } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// CSI sequences, OSC sequences (title sets, hyperlinks), and lone two-byte escapes; always stripped as noise.
// eslint-disable-next-line no-control-regex
export const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

// A spinner/progress bar redraws one line with \r: keep only the final frame. Always applied as noise.
export const collapseCr = (line) => {
    const frames = line.split("\r");
    for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i] !== "") {
            return frames[i];
        }
    }
    return "";
};

// Success-path per-command noise strippers. Narrow patterns: a false command match strips nothing real.
const strip = (id, match, patterns) => ({
    id,
    match,
    apply: (lines) => lines.filter((line) => !patterns.some((re) => re.test(line))),
});

// Matches the command word itself, not a filename containing it, even through a launcher's quoting. Lookbehind only
// excludes being the tail of a path or identifier; `/` stays in so `/usr/bin/pnpm` still matches.
const invocation = (word) => new RegExp(String.raw`(?<![\w.\-/])(?:${word})(?![\w.-])`);

// Weight of a line array joined with newlines, without building the string each stage.
export const bodyBytes = (lines) => (lines.length === 0 ? 0 : lines.reduce((sum, line) => sum + line.length, 0) + lines.length - 1);

// Shape cleaners read the text, not the command, since `cd x && …` defeats a command regex. Each self-gates, handing
// back its input unchanged when it recognizes nothing, so it's safe to run on every success.

const humanSize = (bytes) =>
    bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)}M` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}K` : `${bytes}B`;

// `-rwsr-xr-t` → `4755`: lower s/t means the special bit plus execute, upper S/T the special bit alone. Leading digit
// only appears when a special bit is set.
const EXECUTABLE = new Set(["x", "s", "t"]);
const permsToOctal = (perms) => {
    const triad = (read, write, exec) => (perms[read] === "r" ? 4 : 0) + (perms[write] === "w" ? 2 : 0) + (EXECUTABLE.has(perms[exec]) ? 1 : 0);
    const special = ("sS".includes(perms[3]) ? 4 : 0) + ("sS".includes(perms[6]) ? 2 : 0) + ("tT".includes(perms[9]) ? 1 : 0);
    const mode = `${triad(1, 2, 3)}${triad(4, 5, 6)}${triad(7, 8, 9)}`;
    return special > 0 ? `${special}${mode}` : mode;
};

// Anchors on the date, not a column index, since a name with a space shifts every column left of it. Matches both GNU
// date spellings: the default and `--time-style=long-iso`.
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
    // Size is the rightmost integer before the date; the link count is numeric too but comes first.
    const size = head.reduceRight((found, token) => (found === undefined && /^\d+$/.test(token) ? Number(token) : found), undefined);
    return { mode: permsToOctal(head[0]), directory: head[0].startsWith("d"), size, name: line.slice(date.index + date[0].length) };
};

// Rewrites each entry to `<octal> <name>[/] <size>`, dropping the `total N` header and `.`/`..`. Order is preserved:
// reordering would silently break `ls -lt`.
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
    // Nothing recognised: a non-English locale, or not a listing at all. Hand back exactly what came in.
    return parsed === 0 ? lines : out;
};

// Bare-path runs (`find`, `git ls-files`, `rg -l`, `ls -R`) repeat their directory prefix on nearly every line; folded
// to one line per directory, every name kept.
const PATH_RUN_MIN = 10;
const PATH_RUN_DIRS = 60;
const PATH_RUN_NAMES = 40;

// No whitespace (a listing has plenty), no `:<digit>` (a `file:line:` diagnostic, not a path), nothing absurdly long.
// Strict on purpose: a misread here folds the wrong shape.
const isPathLine = (line) => line !== "" && !/\s/.test(line) && !/:\d/.test(line) && line.length < 300;

// Longest directory prefix every entry shares, trimmed one whole segment at a time so the result is always a real
// directory, never a truncated name.
const sharedRoot = (directories) => {
    if (directories.length < 2) {
        return "";
    }
    let prefix = directories[0];
    for (const directory of directories) {
        while (prefix !== "" && !directory.startsWith(prefix)) {
            const shorter = prefix.slice(0, prefix.lastIndexOf("/", prefix.length - 2) + 1);
            // "/" has no shorter form; a run mixing absolute and relative paths shares no root, so this terminates.
            prefix = shorter === prefix ? "" : shorter;
        }
    }
    return prefix;
};

const foldPaths = (run) => {
    // A run of loose words is not a path list: real `find` output is dominated by lines carrying a directory.
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

// A grep hit repeats its file on every line; said once, with later hits indented under it, losslessly. Only CONSECUTIVE
// hits fold, never regrouped, preserving the tool's own order; the first hit keeps its full `path:line:` spelling.
const HIT_LINE = /^([^\s:][^:]{0,240}):(\d+):(?:(\d+):)?(.*)$/;
// A timestamp like `12:34:56` parses as `path:line:` too; requiring a `/` or `.` in the key is what excludes it as a
// hit.
const HIT_RUN_MIN = 6;
const isHitKey = (key) => key.includes("/") || key.includes(".");
const parseHit = (line) => {
    const match = HIT_LINE.exec(line);
    return match !== null && isHitKey(match[1]) ? match : undefined;
};

// One run of hits, already long enough to fold: first hit of each file keeps its path, the rest indent under it. `run`
// is uniform, so no need to re-check for a non-hit.
const foldHitRun = (run) => {
    const folded = [];
    for (let start = 0; start < run.length; ) {
        const file = parseHit(run[start])[1];
        folded.push(run[start]);
        let next = start + 1;
        while (next < run.length && parseHit(run[next])[1] === file) {
            const hit = parseHit(run[next]);
            folded.push(`  ${hit[2]}${hit[3] === undefined ? "" : `:${hit[3]}`}:${hit[4]}`);
            next++;
        }
        start = next;
    }
    // One hit per file folds to exactly what it replaced; then the fold is simply not taken.
    return bodyBytes(folded) < bodyBytes(run) ? folded : run;
};

const foldHitRuns = (lines) => {
    const out = [];
    for (let i = 0; i < lines.length; ) {
        let end = i;
        while (end < lines.length && parseHit(lines[end]) !== undefined) {
            end++;
        }
        // Not a run at all (end === i) steps one line; a run too short to fold is emitted as it came.
        const stop = Math.max(end, i + 1);
        out.push(...(end - i >= HIT_RUN_MIN ? foldHitRun(lines.slice(i, end)) : lines.slice(i, stop)));
        i = stop;
    }
    return out;
};

// Command-scoped cleaners (id + command regex + transform) and shape cleaners (no `match`, offered on every success);
// composable, every enabled match runs in array order.
const COMMAND_CLEANERS = [
    strip("pnpm", invocation(String.raw`pnpm`), [
        /^\s*Progress: /,
        /^Packages: [+-]/,
        /^Downloading /,
        /^\s*[.+]+\s*$/,
        /^Virtual store is at/,
        /^Lockfile is up to date/,
    ]),
    // `apt-get` before `apt`: ordered alternation, or the guard rejects the longer spelling at its hyphen.
    strip("apt", invocation(String.raw`apt-get|apt`), [
        /^(?:Get:|Hit:|Ign:|Fetched |Selecting |Preparing to unpack|Unpacking |Setting up |Processing triggers)/,
    ]),
    // Test runners: on a green run (exit 0) per-test PASS lines are noise, dropped, keeping the summary. Failures skip
    // all command cleaners, so failing tests survive verbatim.
    strip("test", invocation(String.raw`vitest|jest|pytest|rspec|mocha|phpunit|go\s+test|cargo\s+test`), [
        /^\s*[✓√]\s/, // per-test pass (vitest/jest/mocha)
        /^--- PASS:/, // go test per-test
        /^\s*test .+\.\.\. ok$/, // cargo test per-test
        /^PASS\s+\S/, // jest per-file PASS header
        /^\s*[.·]+\s*$/, // pytest/mocha dot progress
    ]),
    { id: "ls", apply: compactListing },
    { id: "files", apply: foldPathRuns },
    { id: "hits", apply: foldHitRuns },
];

// Every registry cleaner id plus the global stages: dedup and redact run on all output, cap is head/tail truncation,
// cache collapses an identical repeat (owned by agent-output-filter).
export const CLEANERS = [...COMMAND_CLEANERS.map((cleaner) => cleaner.id), "dedup", "cap", "redact", "cache"];

// Collapses a run of 3+ identical consecutive lines to one line plus a count marker. Lossless on distinct content, so
// it's safe on both success output and repeated failure traces.
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

// Masks common secret shapes before output reaches the model, as defense-in-depth. A secret-shaped NAME is not enough
// (source often says "token" without holding one), so the VALUE must look like a credential too.
const SECRET_NAME = String.raw`[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Za-z0-9_]*`;
// A single `=` or `:`, never `===`/`!==`/`=>`; optional closing quote covers a quoted JSON key.
const ASSIGN = String.raw`["']?\s*[:=](?![=>])\s*`;
// `\x60` is a backtick: template-literal values are quoted too.
const QUOTED_VALUE = String.raw`(["'\x60])([^"'\x60\n]{6,})\2`;
// No `.` (property access) and not a call: `usage.inputTokens` and `computed(` are expressions, not values.
const BARE_VALUE = String.raw`[\w+/=~-]{6,}(?![\w+/=~(-])`;

// What counts as a credential once the NAME already matched: machine-generated values carry letters and digits
// together, but so do plain counts and paths.
//   1. A known issuer prefix (`sk-`, `ghp_`, `AKIA`, `eyJ`, …) is a credential at any length.
//   2. Otherwise it must be entropic and not: all-digits, a path/URL/`${template}`, or SCREAMING_SNAKE (a name, not a
//      value).
//   3. And longer than a human would type, or it might be a fixture value like `"tok-abc-123"`.
// The gap is deliberate: a handwritten passphrase reads exactly like an identifier.
const ISSUER_PREFIX = /^(?:sk-|pk-|rk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abposr]-|AKIA|ASIA|eyJ|AIza|ya29\.|glpat-|dop_v1_|shpat_|SG\.|npm_)/;
const NUMERIC_VALUE = /^[\d_,.]+$/;
const STRUCTURAL_VALUE = /[\s/\\${}]/;
const ENV_NAME_VALUE = /^[A-Z0-9_]+$/;
const ENTROPIC_VALUE = /^(?=[^\n]*\d)(?=[^\n]*[A-Za-z])/;
const HANDWRITTEN_MAX = 12;
const looksLikeCredential = (value) =>
    ISSUER_PREFIX.test(value) ||
    (value.length > HANDWRITTEN_MAX &&
        ENTROPIC_VALUE.test(value) &&
        !NUMERIC_VALUE.test(value) &&
        !STRUCTURAL_VALUE.test(value) &&
        !ENV_NAME_VALUE.test(value));

const SECRET_PATTERNS = [
    [
        new RegExp(`\\b(${SECRET_NAME}${ASSIGN})(?:${QUOTED_VALUE}|(${BARE_VALUE}))`, "gi"),
        // Quoted and bare arrive in different groups because only the quoted one has a quote to put back.
        (match, assignment, quote, quoted, bare) => (looksLikeCredential(quoted ?? bare) ? `${assignment}${quote ?? ""}***${quote ?? ""}` : match),
    ],
    [/\bAKIA[0-9A-Z]{16}\b/g, "***"],
    // Same rule for a bearer value: prose about tokens carries no digit, every real bearer token does.
    [/\b(Bearer\s+)(?=[\w.-]*\d)[\w.-]{8,}/gi, "$1***"],
    [/\b(https?:\/\/[^:@\s/]+:)[^@\s]+@/gi, "$1***@"],
];
// Known secret VALUES (from the daemon's own env) mask exactly, with no per-field upkeep; name patterns above are a
// backstop only for a value not stored here. A known value masks to its reference (`{{secret:name}}`); a multi-line
// value masks per line to the anonymous mask instead, since a reference stands for the whole value.
const SECRET_VALUE_MIN = 12;
const secretValueCache = new Map();

const readIfChanged = (path, name) => {
    try {
        // Opens once, then stats and reads that descriptor: a path-level stat then read would let a symlink swap
        // redirect the reader in between.
        const descriptor = openSync(path, "r");
        try {
            const { mtimeMs, size } = fstatSync(descriptor);
            const stamp = `${mtimeMs}:${size}`;
            const cached = secretValueCache.get(path);
            if (cached?.stamp === stamp) {
                return cached.values;
            }
            const values = harvest(readFileSync(descriptor, "utf8"), path, name);
            secretValueCache.set(path, { stamp, values });
            return values;
        } finally {
            closeSync(descriptor);
        }
    } catch {
        // Absent, unreadable, or malformed: the name patterns still run. Never a reason to fail a command.
        return [];
    }
};

// Every form a value can arrive in; mirrors src/secrets/secret-registry.ts surfaceForms (duplicated: this filter has no
// daemon or build step). Only registering the raw form would miss a JSON-escaped or percent-encoded secret.
export const surfaceForms = (value) => {
    const forms = [value];
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    if (jsonEscaped !== value) {
        forms.push(jsonEscaped);
    }
    try {
        const encoded = encodeURIComponent(value);
        if (encoded !== value) {
            forms.push(encoded);
        }
    } catch {
        // A lone surrogate makes encodeURIComponent throw; such a value cannot reach a reader encoded either.
    }
    return forms;
};

// Every {target, replacement} to mask, from one of three files: the vault is {id: {field: value}} (named
// `<id>/<field>`), `.env` is KEY=value, `.secrets.json` is flat {KEY: value}. Reads only VALUES; a key name is not a
// secret.
const harvest = (text, path, name) => {
    const named = [];
    if (path.endsWith("capability-secrets.json")) {
        for (const [id, entry] of Object.entries(JSON.parse(text))) {
            if (entry === null || typeof entry !== "object") {
                continue;
            }
            for (const [field, value] of Object.entries(entry)) {
                if (typeof value === "string") {
                    named.push([name(id, field), value]);
                }
            }
        }
    } else if (path.endsWith(".json")) {
        for (const [key, value] of Object.entries(JSON.parse(text))) {
            if (typeof value === "string") {
                named.push([name(key), value]);
            }
        }
    } else {
        for (const line of text.split("\n")) {
            const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
            if (match !== null) {
                named.push([name(match[1]), (match[2] ?? "").trim().replace(/^(["'])([\s\S]*)\1$/, "$2")]);
            }
        }
    }
    const byTarget = new Map();
    const add = (target, replacement) => {
        const trimmed = target.trim();
        if (trimmed.length >= SECRET_VALUE_MIN && !byTarget.has(trimmed)) {
            byTarget.set(trimmed, { target: trimmed, replacement });
        }
    };
    for (const [reference, value] of named) {
        // Trimmed first: whitespace padding is never masked, so an untrimmed target would never match anything.
        for (const form of surfaceForms(value.trim())) {
            add(form, `{{secret:${reference}}}`);
        }
        if (value.includes("\n")) {
            for (const line of value.split("\n")) {
                add(line, "***");
            }
        }
    }
    // Longest first, so a value that contains another is masked whole rather than leaving its tail behind.
    return [...byTarget.values()].toSorted((a, b) => b.target.length - a.target.length);
};

// Where the three stores live, from the daemon's own env for this turn. AGENT_AUTH_DIR is the provider-credential root;
// unset falls back to .intentic/secrets/auth, matching composition.ts.
export const secretValues = (env = process.env) => {
    const authRoot =
        env.AGENT_AUTH_DIR !== undefined && env.AGENT_AUTH_DIR !== ""
            ? env.AGENT_AUTH_DIR
            : join(env.WORKSPACE_ROOT ?? "/work", ".intentic/secrets/auth");
    const repo = join(env.WORKSPACE_ROOT ?? "/work", "desired-state");
    return [
        ...readIfChanged(join(authRoot, "capability-secrets.json"), (id, field) => `${id}/${field}`),
        ...readIfChanged(join(repo, ".env"), (key) => key),
        ...readIfChanged(join(repo, ".secrets.json"), (key) => key),
    ].toSorted((a, b) => b.target.length - a.target.length);
};

// Masks a whole body for the two paths that skip the pipeline: the holdout and the fail-open catch. Neither excuses
// handing over a credential; idempotent, so re-running it after the pipeline already masked a line costs a scan and
// changes nothing.
export const redactText = (text, values = []) =>
    text
        .split("\n")
        .map((line) => redactLine(line, values))
        .join("\n");

const redactLine = (line, values = []) => {
    let masked = line;
    for (const { target, replacement } of values) {
        if (masked.includes(target)) {
            masked = masked.split(target).join(replacement);
        }
    }
    return SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), masked);
};

// Allow-list if any token lacks `-` ("git,pnpm" = only those), else default-minus ("-git" = all except);
// empty/undefined = all on. Unlike iq's parseFeatures, unknown tokens are ignored rather than thrown, so a typo'd
// setting can't break a tool result.
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

// Generic success cap: outputs past MAX keep the first HEAD and last TAIL lines. Failures keep everything up to
// FAIL_TAIL, since errors live at the end.
const HEAD = 30;
const TAIL = 50;
const MAX = 100;
const FAIL_TAIL = 500;

// A line is not a unit of size: some commands return few lines of very long ones. These byte budgets are generous
// enough that ordinary output never meets them, firing only on the long-line shapes the line cap can't see.
const LOG_MAX_BYTES = 16_000;
const READ_MAX_BYTES = 96_000;
// Head/tail split of a byte budget mirrors the line cap's 30/50 bias toward the end, where a log's signal is.
const BYTE_HEAD_SHARE = 0.375;

// A deliberate read (`cat`, `sed -n`, `awk`, `git diff/show` on a path) is not a log's noise-at-both-ends shape, so it
// gets the Read tool's own line ceiling instead of the log cap, trimmed from the end where a read naturally stops.
const READ_MAX = 2000;
// Narrow on the right: `git log` without `-p` is history, `git log -p` is a read. Permissive on the left: the
// lookbehind only excludes being the tail of a path or identifier, accepting a quote, `--`, or statement start alike.

// Git's global options before the verb, in two shapes: a flag glued to its value (`--no-pager`) is one token, but
// several take the value as a separate word. The list is explicit rather than "any flag takes a value", which could
// swallow the verb itself.
const GIT_OPTIONS = String.raw`(?:(?:-[Cc]|--(?:git-dir|work-tree|namespace|exec-path|super-prefix))\s+\S+\s+|-\S+\s+)*`;
const READ_COMMAND = new RegExp(
    String.raw`(?<![\w.-])(?:cat|bat|sed\s+-n|awk|git\s+${GIT_OPTIONS}(?:diff|show)\b|git\s+${GIT_OPTIONS}log\s+(?:[^;&|]*\s)?-p)\b`,
);

// Takes whole lines until `budget` bytes are spent; a partial line would misrepresent the output it came from.
const takeWithinBudget = (source, budget) => {
    const kept = [];
    let spent = 0;
    for (const line of source) {
        spent += line.length + 1;
        if (spent > budget) {
            break;
        }
        kept.push(line);
    }
    return kept;
};

// Caps on lines OR bytes, whichever policy the command earned. Returns the same array unchanged when nothing is over
// budget, so the caller can tell "did not fire" from "fired and removed nothing".
const capOutput = (lines, command) => {
    const isRead = READ_COMMAND.test(command);
    const maxLines = isRead ? READ_MAX : MAX;
    const maxBytes = isRead ? READ_MAX_BYTES : LOG_MAX_BYTES;
    // Lines first: it is the cheaper test and the one whose elision marker reads best.
    if (lines.length > maxLines) {
        return isRead
            ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines elided: narrow the range or use the Read tool …`]
            : [...lines.slice(0, HEAD), `… ${lines.length - HEAD - TAIL} lines elided …`, ...lines.slice(-TAIL)];
    }
    if (bodyBytes(lines) <= maxBytes) {
        return lines;
    }
    // Over on bytes within the line limit means long lines: take from the end for a read, both ends for a log.
    if (isRead) {
        const head = takeWithinBudget(lines, maxBytes);
        return [...head, `… ${lines.length - head.length} more lines elided (${bodyBytes(lines)} bytes): narrow the range or use the Read tool …`];
    }
    const head = takeWithinBudget(lines, Math.round(maxBytes * BYTE_HEAD_SHARE));
    const tail = takeWithinBudget(lines.toReversed(), maxBytes - bodyBytes(head)).toReversed();
    // A single line longer than the whole budget leaves both ends empty; keep its head rather than only a marker.
    if (head.length === 0 && tail.length === 0) {
        return [`${lines[0].slice(0, maxBytes)}… line truncated at ${maxBytes} bytes …`];
    }
    return [...head, `… ${lines.length - head.length - tail.length} lines elided (${bodyBytes(lines)} bytes) …`, ...tail];
};

// Gated pipeline over ANSI/\r-cleaned lines: success runs matching command cleaners then the cap; failure keeps
// everything but a generous tail. Stages are weighed sequentially, so they sum to the total saving — a cleaner before
// the cap gets credit for lines the cap would have taken anyway.
export const cleanLines = (lines, { command, exitCode, enabled, values = [] }) => {
    const stages = [];
    let out = lines;
    let bytes = bodyBytes(lines);
    // Weighs one stage against what reached it, recording the difference under its id — even 0, so the report can tell
    // "fired and worth nothing" from "never ran".
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
        if (enabled.has("cap")) {
            const capped = capOutput(out, command);
            if (capped !== out) {
                ran("cap", capped);
            }
        }
    } else {
        // Failures keep detail verbatim: only collapse long identical runs (lossless) and cap at a generous tail.
        if (enabled.has("dedup")) {
            ran("dedup", dedupeRuns(out));
        }
        if (out.length > FAIL_TAIL) {
            // Own id, never `cap`: this fires regardless of the spec, so `cap`'s toggle shouldn't get credit for it.
            ran("failtail", [`… ${out.length - FAIL_TAIL} earlier lines elided …`, ...out.slice(-FAIL_TAIL)]);
        }
    }
    // Redaction runs last on both paths so a leaked secret is masked even inside an error dump.
    if (enabled.has("redact")) {
        ran(
            "redact",
            out.map((line) => redactLine(line, values)),
        );
    }
    return { lines: out, stages };
};

// Which cleaners CLAIMED this command, recorded for the `gaps` report. Command-scoped only: a shape cleaner decides
// from the output, not in advance, so counting it here would make every command look handled.
export const matchedCleaners = (command, enabled) =>
    COMMAND_CLEANERS.filter((cleaner) => cleaner.match !== undefined && enabled.has(cleaner.id) && cleaner.match.test(command)).map(
        (cleaner) => cleaner.id,
    );

// cache: when a command's cleaned output repeats a previous run's byte-for-byte this session, replace it with a pointer
// to the retrieval handle. Stateful, so agent-output-filter owns the store rather than the pure cleanLines pipeline.

// Sentinel the collapse emits; agent-output-filter matches on it to record `cache`. A prefix, not the whole line: the
// two collapse messages complete it differently.
export const CACHE_MARKER = "(output identical to ";

// A body must be worth more than the ~130-byte marker, or collapsing it costs more than it saves. Short bodies also
// COLLIDE across unrelated commands (`""`, `"0"`), naming the wrong one as the source.
const CACHE_MIN_BYTES = 512;
// The back-reference carries the earlier command; a long one balloons the marker meant to be small.
const CACHE_COMMAND_MAX = 120;

const hashText = (text) => createHash("sha1").update(text).digest("hex");

// Every command in a session runs in a new tmux window (new pane id), so this strips the trailing `-<pane>.log` to
// recover the shared `agent-<id>` name. Undefined means no stable key, so the cache just never hits.
export const sessionKeyFromLog = (logPath) => {
    if (logPath === undefined || logPath === "") {
        return undefined;
    }
    const base = logPath.split("/").pop() ?? "";
    const match = base.match(/^(.*)-[^-]+\.log$/);
    return match !== null && match[1] !== "" ? match[1] : undefined;
};

// File-backed store of commandHash → bodyHash under <terminalsDir>/../output-cache/<sessionKey>.json, read once and
// rewritten on each miss. Fail-open on I/O error.
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

// Pure given `store` (lookup/record): on a hit, returns the collapse marker; otherwise records and passes the body
// through. Tests inject an in-memory store.
export const collapseCached = (body, command, store, logPath) => {
    // Below the floor, nothing is worth collapsing or remembering: recording a short body risks naming it as the
    // "earlier command" for an unrelated one.
    if (body.length < CACHE_MIN_BYTES) {
        return { body, cached: false };
    }
    const commandHash = `c:${hashText(command)}`;
    const bodyKey = `b:${hashText(body)}`;
    const bodyHash = hashText(body);
    const handle = logPath !== undefined && logPath !== "" ? ` · retrieve-output ${logPath}` : "";
    if (store.lookup(commandHash) === bodyHash) {
        return { body: `${CACHE_MARKER}a previous run this session${handle})`, cached: true };
    }
    // The same output can come from a different command (reading a file two ways, two spellings of the same script);
    // naming the earlier command lets the model act on the pointer instead of guessing which result it matches.
    const earlier = store.lookup(bodyKey);
    if (earlier !== undefined && earlier !== command) {
        const named = earlier.length > CACHE_COMMAND_MAX ? `${earlier.slice(0, CACHE_COMMAND_MAX)}…` : earlier;
        return { body: `${CACHE_MARKER}the output of \`${named}\` earlier this session${handle})`, cached: true };
    }
    store.record(commandHash, bodyHash);
    // First writer of a body wins the back-reference: re-recording on every match would keep moving the pointer toward
    // the reader until it named the call right above.
    if (earlier === undefined) {
        store.record(bodyKey, command);
    }
    return { body, cached: false };
};
