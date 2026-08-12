// The output-cleaner registry behind agent-output-filter. Each cleaner has a stable `id`; the active set is a
// spec (INTENTIC_OUTPUT_CLEANERS) parsed the same way as iq's --features (allow-list / default-minus), so
// cleaners can be flipped on/off and A/B benchmarked exactly like iq's retrieval stages. Plain .mjs (no build
// step) — imported by agent-output-filter and unit tests. Kept dependency-free (node builtins only) so the
// filter never breaks.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
// might echo env/config. Only secret-named assignments, AWS access keys, bearer tokens, URL creds.
//
// A secret-shaped NAME is not enough, because source code says "token" constantly. Matching on the name alone
// masked `oauthToken === undefined` as `oauthToken =*** undefined` (a model cannot tell that from `!==`),
// `let oauthToken: string` as `oauthToken: ***`, and `usage.inputTokens ?? 0` as `*** ?? 0` — silently, on
// every read of the file through the shell. So the VALUE has to look like a credential too.
const SECRET_NAME = String.raw`[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Za-z0-9_]*`;
// A single `=` or `:`, never `===`/`!==`/`=>` — that alone rules out every comparison and arrow function. The
// optional closing quote is what covers a JSON config dump, where the key itself is quoted.
const ASSIGN = String.raw`["']?\s*[:=](?![=>])\s*`;
// (`\x60` is a backtick: template-literal values are quoted too.)
const QUOTED_VALUE = String.raw`(["'\x60])([^"'\x60\n]{6,})\2`;
// No `.` (property access) and not a call: `usage.inputTokens` and `computed(` are expressions, not values.
const BARE_VALUE = String.raw`[\w+/=~-]{6,}(?![\w+/=~(-])`;

/* WHAT A CREDENTIAL VALUE LOOKS LIKE, given that the NAME already matched.
 *
 * The name alone is not enough, because source code says "token" constantly — that much the pattern above
 * always knew. What it got wrong is the other half: it treated "≥6 characters carrying a digit" as
 * credential-shaped, and in a workspace whose subject matter IS tokens that fires on the data. Measured over
 * one day it masked 182 lines and caught zero secrets: `"cacheReadTokens":26170149` (breaking the JSON for
 * every reader downstream), `readonly inputTokens: 1234567`, `maxTokens: 200000`, `--max-tokens=131072`, and
 * every short fixture value in the test suite. Worse, the 6-character floor made the mask fire as a function of
 * MAGNITUDE — `"outputTokens": 94746` survived and the same field one order up did not — so it passed every
 * small test and only broke on production-scale numbers.
 *
 * The rule the original reached for is still the right one — a credential is MACHINE-GENERATED, so it carries
 * letters and digits together — and what it was missing is that three other things do too. So, in order of
 * confidence:
 *   1. A known issuer prefix is a credential at any length. `sk-`, `ghp_`, `AKIA`, `eyJ` and friends are
 *      unambiguous, and they are what actually leaks.
 *   2. Otherwise the value must be entropic AND none of the three shapes that fake it:
 *        · all digits — a count, and this workspace is made of them (`26170149`, `200_000`, `131072`);
 *        · a path, URL or `${template}` — `${STATE_DIR}/runner-token`, `/run/intentic/agent.token`;
 *        · SCREAMING_SNAKE — the NAME of a variable passed as a string, not its value.
 *   3. And it must be longer than a human would type, which is what separates a generated key from the
 *      fixture values the model needs to read (`"tok-abc-123"`, `"test-secret"`).
 * The deliberate gap is unchanged from the original: an all-lowercase handwritten passphrase reads exactly like
 * an identifier, and nothing in the text separates them. */
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
    // Same rule for the bearer value: prose ("refuses every bearer token", "the bearer is valid") carries no
    // digit, every real bearer does.
    [/\b(Bearer\s+)(?=[\w.-]*\d)[\w.-]{8,}/gi, "$1***"],
    [/\b(https?:\/\/[^:@\s/]+:)[^@\s]+@/gi, "$1***@"],
];
/* THE VALUES THIS SANDBOX ACTUALLY HOLDS — the half of redaction that does not have to guess.
 *
 * Everything above infers a credential from the NAME beside it, and that inference has a floor it cannot get
 * past: it only masks what somebody thought to call a token. Measured against the field names the capability
 * union itself declares secret, five of six shapes went straight through — `presharedKey`, an agent's `env`
 * block, a wireguard `config`, and any name a third-party connector invents (`pat`, `seed`). The name list can
 * always be extended and will always be behind.
 *
 * The daemon does not have to infer anything: it composes these values into the agent's environment every turn,
 * so it knows them exactly. Masking by value is therefore complete for everything stored, in any shape, under
 * any name, and it needs no upkeep when a connector adds a field. The name patterns STAY as the backstop, for
 * the credentials this sandbox does not store — one the agent minted mid-turn, one echoed by a remote command.
 *
 * A KNOWN value is masked TO ITS REFERENCE — `{{secret:name}}`, the same token the daemon's exits resolve
 * back to the value (src/secrets/secret-registry.ts is the naming's home; the vault's `<id>/<field>` and the
 * env/generated KEY are reproduced here because this filter runs without the daemon). The shape patterns
 * above keep the anonymous mask: they GUESS, and a guess must not mint a reference that resolves.
 *
 * Read straight off disk rather than passed in: the three files below are readable by anything running in
 * this container (daemon and agent are both root), so routing them through an env var or argv would add a
 * copy in /proc without adding a boundary. Cached per (path, mtime) — this runs once per Bash command.
 *
 * A MULTI-LINE value (an ssh private key, a WireGuard conf) can never match a line-at-a-time replace, so each
 * of its lines is registered as its own target — to the anonymous mask, not the reference: a reference stands
 * for the WHOLE value, and stamping it per line would make the masked block resolve to N copies of the key.
 * Short fragments are dropped: a PEM's `-----BEGIN` header is not the secret, and masking an 8-character line
 * would blank ordinary output. */
const SECRET_VALUE_MIN = 12;
const secretValueCache = new Map();

const readIfChanged = (path, name) => {
    try {
        const { mtimeMs, size } = statSync(path);
        const stamp = `${mtimeMs}:${size}`;
        const cached = secretValueCache.get(path);
        if (cached?.stamp === stamp) {
            return cached.values;
        }
        const values = harvest(readFileSync(path, "utf8"), path, name);
        secretValueCache.set(path, { stamp, values });
        return values;
    } catch {
        // Absent, unreadable, or malformed: the name patterns still run. Never a reason to fail a command.
        return [];
    }
};

// Every {target, replacement} worth masking out of one of the three files. The vault is {id: {field: value}}
// (named `<id>/<field>`); .env is KEY=value lines and .secrets.json a flat {KEY: value} (named KEY). Read for
// VALUES only — a key name is not a secret and masking it would blank prose.
const harvest = (text, path, name) => {
    const named = [];
    if (path.endsWith("capability-secrets.json")) {
        for (const [id, entry] of Object.entries(JSON.parse(text))) {
            if (entry !== null && typeof entry === "object") {
                for (const [field, value] of Object.entries(entry)) {
                    if (typeof value === "string") {
                        named.push([name(id, field), value]);
                    }
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
    for (const [reference, value] of named) {
        const whole = value.trim();
        if (whole.length >= SECRET_VALUE_MIN && !byTarget.has(whole)) {
            byTarget.set(whole, { target: whole, replacement: `{{secret:${reference}}}` });
        }
        if (value.includes("\n")) {
            for (const line of value.split("\n")) {
                const trimmed = line.trim();
                if (trimmed.length >= SECRET_VALUE_MIN && !byTarget.has(trimmed)) {
                    byTarget.set(trimmed, { target: trimmed, replacement: "***" });
                }
            }
        }
    }
    // Longest first, so a value that contains another is masked whole rather than leaving its tail behind.
    return [...byTarget.values()].toSorted((a, b) => b.target.length - a.target.length);
};

/* Where the three stores live, from the same environment the daemon set for this turn. AGENT_AUTH_DIR is the
 * provider-credential root (off /work); unset — a dev daemon — puts it under .intentic/auth, which is where
 * composition.ts falls back to as well. */
export const secretValues = (env = process.env) => {
    const authRoot =
        env.AGENT_AUTH_DIR !== undefined && env.AGENT_AUTH_DIR !== "" ? env.AGENT_AUTH_DIR : join(env.WORKSPACE_ROOT ?? "/work", ".intentic/auth");
    const repo = join(env.WORKSPACE_ROOT ?? "/work", "desired-state");
    return [
        ...readIfChanged(join(authRoot, "capability-secrets.json"), (id, field) => `${id}/${field}`),
        ...readIfChanged(join(repo, ".env"), (key) => key),
        ...readIfChanged(join(repo, ".secrets.json"), (key) => key),
    ].toSorted((a, b) => b.target.length - a.target.length);
};

/* The same masking over a whole body, for the two paths that emit output WITHOUT running the pipeline: the
 * measurement holdout and the fail-open catch. Neither is a reason to hand over a credential — a control group
 * is still a tool result the model reads, and a filter that threw is the moment least worth trusting. Idempotent,
 * so running it after the pipeline has already masked a line costs a scan and changes nothing. */
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

/* A LINE is not a unit of size, and counting them was a blind spot big enough to see in the ledger: 8.2% of all
 * raw bytes arrived in commands under the 100-line limit that the cap therefore never looked at. `grep -rn
 * --include=*.css` over minified CSS returns sixty lines and 130 KB; a `curl` of a JSON API returns one. The
 * budgets below are the same two policies as the line caps, priced in bytes — generous enough that ordinary
 * output never meets them (the 80-line log cap is ~6 KB of normal text, well under LOG_MAX_BYTES), so this
 * fires only on the long-line shapes the line cap cannot see. */
const LOG_MAX_BYTES = 16_000;
const READ_MAX_BYTES = 96_000;
// Head/tail split of a byte budget mirrors the line cap's 30/50 bias toward the end, where a log's signal is.
const BYTE_HEAD_SHARE = 0.375;

// A deliberate read is not a log. `cat`, `sed -n 40,80p`, `awk NR>=…`, `git diff/show` on a path: the agent
// named the exact bytes it wants, and a build log's shape (noise at both ends, signal at the end) does not
// apply. Capping those at 100 lines is what makes reading a file through the shell WORSE than the Read tool,
// and the transcripts show the loop it creates — a 248-line file arrives as 81 lines with its middle gone, and
// the very next call re-reads the whole file through Read, paying for it twice. So a read gets the Read tool's
// own ceiling, and overshoot is trimmed from the END (where a file read naturally stops) rather than the middle.
const READ_MAX = 2000;
/* Deliberately narrow on the RIGHT — `git log` without `-p` is history (a log, correctly capped), `git log -p`
 * is a read — and deliberately permissive on the LEFT, which is the correction of a real measured failure.
 *
 * This used to anchor at a shell-statement start (`^` or after `;&|`). What it is handed is not the shell
 * statement, though: it is the LAUNCHER line, `nsenter … -- bash -c '<what the model wrote>'`. So `cd x && cat
 * y` was recognised (the `&&` supplied an anchor) and a bare `cat y` was not (the char before it is a quote) —
 * a coin flip on syntax the model had no reason to think mattered. Over one day that misread 88 of 93 shell
 * reads as logs and gutted the middle out of, among others, five reads of the workspace README.
 *
 * The lookbehind keeps the only thing the anchor was really buying — that `--concat`, `bobcat` and `x.cat` are
 * not the `cat` command — while accepting the quote, the `--`, and the statement start alike. The remaining
 * false positive is `<a log> | cat`, which grants a build log the read ceiling instead of the log cap. That
 * trade is deliberate: over-keeping a log costs tokens once, while gutting a file read costs the read AND the
 * re-read that follows it.
 *
 * `git\s+(?:-\S+\s+)*` before the verb because git's global options sit between the two words: `git --no-pager
 * diff` is the form the agent instructions here ask for, and without this it read as a log and had its middle
 * gutted — a 274-line diffstat came back as 81 lines. */
const READ_COMMAND = /(?<![\w.-])(?:cat|bat|sed\s+-n|awk|git\s+(?:-\S+\s+)*(?:diff|show)\b|git\s+(?:-\S+\s+)*log\s+(?:[^;&|]*\s)?-p)\b/;

// Whole lines from the front of `source` until `budget` bytes are spent — a partial line would misrepresent the
// output it came from, so the budget is spent in line-sized steps or not at all.
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

/* The cap as one decision: too many lines OR too many bytes, under whichever policy the command earned. Returns
 * the same array when nothing is over budget, so the caller can tell "did not fire" from "fired and removed
 * nothing" — the distinction the stage ledger is built on. */
const capOutput = (lines, command) => {
    const isRead = READ_COMMAND.test(command);
    const maxLines = isRead ? READ_MAX : MAX;
    const maxBytes = isRead ? READ_MAX_BYTES : LOG_MAX_BYTES;
    // Lines first: it is the cheaper test and the one whose elision marker reads best.
    if (lines.length > maxLines) {
        return isRead
            ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines elided — narrow the range or use the Read tool …`]
            : [...lines.slice(0, HEAD), `… ${lines.length - HEAD - TAIL} lines elided …`, ...lines.slice(-TAIL)];
    }
    if (bodyBytes(lines) <= maxBytes) {
        return lines;
    }
    // Over budget on bytes inside the line limit ⇒ long lines. Take whole lines until the budget is spent, from
    // the end for a read (where a file read naturally stops) and from both ends for a log.
    if (isRead) {
        const head = takeWithinBudget(lines, maxBytes);
        return [...head, `… ${lines.length - head.length} more lines elided (${bodyBytes(lines)} bytes) — narrow the range or use the Read tool …`];
    }
    const head = takeWithinBudget(lines, Math.round(maxBytes * BYTE_HEAD_SHARE));
    const tail = takeWithinBudget(lines.toReversed(), maxBytes - bodyBytes(head)).toReversed();
    // A single line longer than the whole budget leaves both ends empty; keep the head of that one line rather
    // than emitting nothing but a marker.
    if (head.length === 0 && tail.length === 0) {
        return [`${lines[0].slice(0, maxBytes)}… line truncated at ${maxBytes} bytes …`];
    }
    return [...head, `… ${lines.length - head.length - tail.length} lines elided (${bodyBytes(lines)} bytes) …`, ...tail];
};

// The gated cleaning pipeline over already-split, ANSI/\r-cleaned lines. Exit-code-asymmetric: on success run the
// matching command cleaners then the cap; on failure keep everything but a generous tail. `enabled` gates each id.
//
// Returns the cleaned lines AND what each stage removed, in pipeline order — the per-mechanism attribution the
// savings report is built on. It is sequential by construction (each stage is weighed against what reached it,
// not against the raw capture), which is what makes the stages sum exactly to the total saving and lets them be
// drawn as one stacked bar. The flip side, and the reason the UI must not label these "what turning this off
// would save": a cleaner that runs before the cap is credited with lines the cap would have taken anyway.
export const cleanLines = (lines, { command, exitCode, enabled, values = [] }) => {
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
        if (enabled.has("cap")) {
            const capped = capOutput(out, command);
            if (capped !== out) {
                ran("cap", capped);
            }
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
        ran(
            "redact",
            out.map((line) => redactLine(line, values)),
        );
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
// A PREFIX, not the whole line: the two collapses complete it differently ("a previous run this session" when
// the same command repeats, "the output of `<cmd>` earlier this session" when a different one produced the
// identical body), and attribution keys on what they share.
export const CACHE_MARKER = "(output identical to ";

/* A body has to be worth more than the pointer that replaces it, and small ones never are. The marker is ~130
 * bytes before it names anything, so collapsing a four-byte "OK" produced a result 400 bytes LONGER than the
 * output — over one ledger window that happened on 78 of 90 collapses, every one of them reverted by `guard`
 * (which throws away the rest of the pipeline's work with it).
 *
 * The floor is not only an accounting fix. Short bodies COLLIDE: "", "0", a bare status line are emitted by
 * commands with nothing to do with each other, and the cross-command back-reference then names one of them,
 * which is how a desktop-install verification came back as "identical to the output of `sleep 90; cat
 * /tmp/smoke-run1.log`". A pointer the reader cannot act on is worse than the bytes it saved. */
const CACHE_MIN_BYTES = 512;
// The back-reference carries the earlier command; a long one balloons the very marker that is meant to be small.
const CACHE_COMMAND_MAX = 120;

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
    // Below the floor there is nothing worth collapsing and nothing worth remembering: recording a colliding
    // short body is what lets it be named as the "earlier command" for an unrelated one later.
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
    /* The other half of the same saving: this exact output already came back from a DIFFERENT command. Reading
     * a file with `cat` and then with `sed -n`, re-running a suite through two spellings of the same script,
     * `git diff` after a `git diff --stat` that changed nothing — each pays full price under a command-keyed
     * cache, because the key it is keyed by is the thing that differed.
     *
     * Naming the earlier command is what makes the collapse safe to act on. "Duplicate output" alone leaves the
     * model to guess WHICH earlier result this equals, and the guess is worth less than the tokens it saved;
     * with the command named, the marker is a pointer into the transcript the model can actually follow. */
    const earlier = store.lookup(bodyKey);
    if (earlier !== undefined && earlier !== command) {
        const named = earlier.length > CACHE_COMMAND_MAX ? `${earlier.slice(0, CACHE_COMMAND_MAX)}…` : earlier;
        return { body: `${CACHE_MARKER}the output of \`${named}\` earlier this session${handle})`, cached: true };
    }
    store.record(commandHash, bodyHash);
    // First writer of a body wins the back-reference: the earliest command is the one furthest up the
    // transcript, so re-recording on every match would keep moving the pointer toward the reader and
    // eventually name the call right above — which says nothing.
    if (earlier === undefined) {
        store.record(bodyKey, command);
    }
    return { body, cached: false };
};
