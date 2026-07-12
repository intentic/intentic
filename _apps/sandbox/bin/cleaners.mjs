// The output-cleaner registry behind agent-output-filter. Each cleaner has a stable `id`; the active set is a
// spec (INTENTIC_OUTPUT_CLEANERS) parsed the same way as iq's --features (allow-list / default-minus), so
// cleaners can be flipped on/off and A/B benchmarked exactly like iq's retrieval stages. Plain .mjs (no build
// step) — imported by agent-output-filter and unit tests. Kept dependency-free so the filter never breaks.

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

// Command-scoped cleaners (id ↔ command regex ↔ transform). Composable: every enabled cleaner whose `match`
// tests the command runs, in array order. Extend here as filter-stats.jsonl surfaces new noisy commands.
export const COMMAND_CLEANERS = [
    strip("npm", /\b(npm|npx)\b/, [/^npm (?:warn|notice)\b/i]),
    strip("pnpm", /\bpnpm\b/, [/^\s*Progress: /, /^Packages: [+-]/, /^Downloading /, /^\s*[.+]+\s*$/, /^Virtual store is at/, /^Lockfile is up to date/]),
    strip("yarn", /\byarn\b/, [/^warning /]),
    strip("docker", /\bdocker\b/, [
        /^#\d+ (?:sha256:|extracting|transferring|resolve|DONE|CACHED)/,
        /(?:Pulling fs layer|Waiting|Downloading|Download complete|Verifying Checksum|Extracting|Pull complete)\s*$/,
    ]),
    strip("git", /\bgit\b/, [/^(?:remote: )?(?:Enumerating|Counting|Compressing|Receiving|Resolving|Unpacking|Writing) (?:objects|deltas)[: ]/, /^remote: Total /]),
    strip("pip", /\bpip3?\b/, [/^\s*(?:Downloading|Using cached|Collecting|Requirement already satisfied)/]),
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
];

// The full toggle vocabulary: every command cleaner id, plus the global stages. `dedup` and `redact` have no
// command match (they run on all output); `cap` is the head/tail truncation.
export const CLEANERS = [...COMMAND_CLEANERS.map((cleaner) => cleaner.id), "dedup", "cap", "redact"];

// Collapse a run of ≥3 identical consecutive lines to one line + a count marker. Lossless on distinct content —
// only repetition is dropped — so it's safe on both success output and repeated failure lines (looping traces).
const dedupeRuns = (lines) => {
    const out = [];
    for (let i = 0; i < lines.length; ) {
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
    [/\b(Bearer\s+)[\w.\-]+/gi, "$1***"],
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
export const HEAD = 30;
export const TAIL = 50;
export const MAX = 100;
export const FAIL_TAIL = 500;

// The gated cleaning pipeline over already-split, ANSI/\r-cleaned lines. Exit-code-asymmetric: on success run the
// matching command cleaners then the cap; on failure keep everything but a generous tail. `enabled` gates each id.
export const cleanLines = (lines, { command, exitCode, enabled }) => {
    let out = lines;
    if (exitCode === "0") {
        for (const cleaner of COMMAND_CLEANERS) {
            if (enabled.has(cleaner.id) && cleaner.match.test(command)) {
                out = cleaner.apply(out);
            }
        }
        if (enabled.has("dedup")) {
            out = dedupeRuns(out);
        }
        if (enabled.has("cap") && out.length > MAX) {
            out = [...out.slice(0, HEAD), `… ${out.length - HEAD - TAIL} lines elided …`, ...out.slice(-TAIL)];
        }
    } else {
        // Failures keep detail verbatim — only collapse long identical runs (lossless) and cap at a generous tail.
        if (enabled.has("dedup")) {
            out = dedupeRuns(out);
        }
        if (out.length > FAIL_TAIL) {
            out = [`… ${out.length - FAIL_TAIL} earlier lines elided …`, ...out.slice(-FAIL_TAIL)];
        }
    }
    // Redaction runs last on both paths so a leaked secret is masked even inside an error dump.
    if (enabled.has("redact")) {
        out = out.map(redactLine);
    }
    return out;
};

// Which command cleaners actually fired for this command — recorded in filter-stats.jsonl to attribute savings.
export const matchedCleaners = (command, enabled) =>
    COMMAND_CLEANERS.filter((cleaner) => enabled.has(cleaner.id) && cleaner.match.test(command)).map((cleaner) => cleaner.id);
