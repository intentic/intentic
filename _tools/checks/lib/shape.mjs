// WHAT code-shape.mjs MEASURES AND HOW A MEASUREMENT FINDS ITS BASELINE ENTRY, with no file or process access, so the
// keying a refactor depends on can be pinned by a test (code-shape.test.mjs).
//
// A measurement is `{ path, symbol, metric, value, line }`: a file's length (`metric: "file"`, no symbol), a function's
// length (`lines`), or a function's `cyclomatic` or `cognitive` complexity as oxlint-plugin-complexity scores it. Only
// what is over its cap is measured at all. A file is keyed by its path; a function by `path#symbol#metric`, with `~2`,
// `~3` on the symbol for a second and third function of the same name in one file.

/** The caps: a file and a function may be this long before the baseline has to hold them. */
export const CAPS = { file: 600, lines: 100 };

/** The complexity metrics, as the plugin's message names them. */
const COMPLEXITY = /^Function '(?<name>[^']*)' has (?<metric>Cognitive Complexity|cyclomatic complexity) of (?<score>\d+)\./u;

/** A complexity finding's metric, score and the name the plugin gives the function, or undefined for any other message. */
export const complexityOf = (message) => {
    const found = COMPLEXITY.exec(message);
    return found === null ? undefined : { metric: found.groups.metric.startsWith(`C`) ? `cognitive` : `cyclomatic`, score: Number(found.groups.score), name: found.groups.name };
};

/** Lines as an editor numbers them: a final newline ends the last line rather than starting another. */
export const lineCount = (text) => (text === `` ? 0 : text.split(`\n`).length - (text.endsWith(`\n`) ? 1 : 0));

/** JSONC as the oxlint configs write it, read as JSON: comments dropped outside strings, trailing commas removed. */
export const parseJsonc = (text) =>
    JSON.parse(text.replaceAll(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, (_, string) => string ?? ``).replaceAll(/,(\s*[}\]])/gu, `$1`));

/** Whether oxlint's `ignorePatterns` (a `**`-prefixed name anywhere, or a path from the root) skip `path`. */
export const ignoredBy = (patterns) => {
    const tests = patterns.map((pattern) => {
        const anywhere = pattern.startsWith(`**/`);
        const body = (anywhere ? pattern.slice(3) : pattern).replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`).replaceAll(`*`, `[^/]*`);
        return new RegExp(`${anywhere ? `(^|/)` : `^`}${body}(/|$)`, `u`);
    });
    return (path) => tests.some((test) => test.test(path));
};

// Beyond what nav's listFiles holds out (tests, generated, dist, fixtures, .d.ts): suite fixtures and vendored copies.
const EXEMPT = /(^|\/)([^/]*\.)?testing\.[cm]?[jt]sx?$|(^|\/)vendor\//u;

/** Whether nav's source file `path` is one this check measures. */
export const measuredSource = (path, ignored) => !EXEMPT.test(path) && !ignored(path);

const ANONYMOUS = `<anonymous>`;

/**
 * nav's functions (functionsOf, in source order) with each anonymous one named after its nearest named enclosing
 * function (`createApp.<anonymous>`), so one callback added in one function does not renumber those in every other.
 */
export const qualified = (functions) => {
    const open = [];
    return functions.map((fn) => {
        while (open.length > 0 && !(open.at(-1).startLine <= fn.startLine && fn.endLine <= open.at(-1).endLine)) {
            open.pop();
        }
        const owner = open.findLast((each) => each.name !== ANONYMOUS);
        const name = fn.name === ANONYMOUS && owner !== undefined ? `${owner.name}.${ANONYMOUS}` : fn.name;
        open.push(fn);
        return { ...fn, name };
    });
};

/** The function a complexity finding at `line` to `endLine` is about: the one starting there whose end is nearest. */
export const functionAt = (functions, line, endLine) =>
    functions.filter((fn) => fn.startLine === line).toSorted((a, b) => Math.abs(a.endLine - endLine) - Math.abs(b.endLine - endLine))[0];

/** A measurement's key with ordinal `ordinal` (1 is the bare name). */
export const keyOf = ({ path, symbol, metric }, ordinal = 1) => (metric === `file` ? path : `${path}#${symbol}${ordinal > 1 ? `~${ordinal}` : ``}#${metric}`);

/** A key's parts; `symbol` drops the ordinal, so every function of one name in one file shares it. */
export const partsOf = (key) => {
    const first = key.indexOf(`#`);
    if (first === -1) {
        return { path: key, metric: `file` };
    }
    const last = key.lastIndexOf(`#`);
    return { path: key.slice(0, first), symbol: key.slice(first + 1, last).replace(/~\d+$/u, ``), metric: key.slice(last + 1) };
};

/** Whether a change to `path` (a file or a directory) can move `key`. */
export const touchedBy = (key, path) => key === path || key.startsWith(`${path}#`) || key.startsWith(`${path}/`);

const groupOf = ({ path, symbol, metric }) => `${path}\0${symbol ?? ``}\0${metric}`;

const grouped = (list, by) => {
    const groups = new Map();
    for (const each of list) {
        groups.set(by(each), [...(groups.get(by(each)) ?? []), each]);
    }
    return groups;
};

// The entry of `free` that `pick` chooses for each item, taken once; answers the items it chose none for.
const take = (items, free, pairs, pick) =>
    items.filter((item) => {
        const at = pick(item);
        if (at === -1) {
            return true;
        }
        pairs.push([item, free[at]]);
        free.splice(at, 1);
        return false;
    });

const indexOfBest = (list, keep, better) => list.reduce((best, each, at) => (keep(each) && (best === -1 || better(each, list[best])) ? at : best), -1);

// One name's functions in one file against that name's entries: an equal score pairs first, so a standing function is
// never blamed for a new one; then each to the smallest entry that still holds it; then what grew, to the largest left.
const pairGroup = (items, entries) => {
    const free = entries.toSorted((a, b) => a.key.localeCompare(b.key));
    const pairs = [];
    let rest = take(
        items.toSorted((a, b) => a.line - b.line),
        free,
        pairs,
        (item) => free.findIndex((entry) => entry.allowance === item.value),
    );
    rest = take(
        rest.toSorted((a, b) => b.value - a.value || a.line - b.line),
        free,
        pairs,
        (item) => indexOfBest(free, (entry) => entry.allowance >= item.value, (a, b) => a.allowance < b.allowance),
    );
    rest = take(rest, free, pairs, () => indexOfBest(free, () => true, (a, b) => a.allowance > b.allowance));
    return { pairs, rest };
};

const dirOf = (path) => path.slice(0, path.lastIndexOf(`/`) + 1);
const baseOf = (path) => path.slice(path.lastIndexOf(`/`) + 1);

// Each measurement under its entry's key where one holds it, else under a fresh key (`fresh`), the ordinal past any taken.
const keyAll = (items, entries, baseline) => {
    const entryGroups = grouped(entries, groupOf);
    const keyed = new Map();
    const fresh = [];
    const claimed = new Set();
    for (const [group, list] of grouped(items, groupOf)) {
        const { pairs, rest } = pairGroup(list, entryGroups.get(group) ?? []);
        for (const [item, entry] of pairs) {
            keyed.set(entry.key, item);
            claimed.add(entry.key);
        }
        for (const item of rest) {
            let ordinal = 1;
            const taken = (key) => baseline.has(key) || keyed.has(key);
            while (taken(keyOf(item, ordinal))) {
                ordinal++;
            }
            keyed.set(keyOf(item, ordinal), item);
            fresh.push(keyOf(item, ordinal));
        }
    }
    return { keyed, fresh, claimed };
};

// A fresh function key takes over an orphan of its metric that holds its score: in its own file first (a rename), else
// one of its name anywhere (a move).
const lendOrphans = (keyed, fresh, orphans, lent) => {
    for (const key of fresh.toSorted()) {
        const item = keyed.get(key);
        if (item.metric === `file`) {
            continue;
        }
        const home = (orphan) => orphan.path === item.path;
        const fits = (orphan) => orphan.metric === item.metric && orphan.allowance >= item.value && (home(orphan) || orphan.symbol === item.symbol);
        const at = indexOfBest(orphans, fits, (a, b) => home(a) > home(b) || (home(a) === home(b) && a.allowance < b.allowance));
        if (at !== -1) {
            lent.set(key, { from: orphans[at].key, count: orphans[at].allowance });
            orphans.splice(at, 1);
        }
    }
};

// A file past what it may hold takes the excess from a file entry the tree now holds less than.
const lendSlack = (keyed, donors, baseline, fileCap, lent) => {
    const rank = (item, donor) => {
        if (donor.gone && baseOf(donor.path) === baseOf(item.path)) {
            return 0;
        }
        return dirOf(donor.path) === dirOf(item.path) ? 1 : 2;
    };
    const files = [...keyed].filter(([key, item]) => item.metric === `file` && item.value > (baseline.get(key) ?? fileCap));
    for (const [key, item] of files.toSorted(([a], [b]) => a.localeCompare(b))) {
        const own = baseline.get(key);
        const needed = item.value - (own ?? fileCap);
        const better = (a, b) => rank(item, a) < rank(item, b) || (rank(item, a) === rank(item, b) && a.slack < b.slack);
        const at = indexOfBest(donors, (donor) => donor.path !== item.path && donor.slack >= needed, better);
        if (at !== -1) {
            lent.set(key, { from: donors[at].key, count: item.value - (own ?? 0) });
            donors[at].slack -= needed;
        }
    }
};

/**
 * Every measurement under its key, and the allowance each borrows from an entry it took over (`lent`, read by
 * lib/ratchet.mjs).
 *
 * `baseline` maps keys to allowances. `measuredPath(path, metric)` says whether this run measured that metric in that
 * file (or the file is gone), so an entry there no measurement claimed is an orphan; `metrics` lists the metrics measured at all;
 * `linesOf(path)` is a file's current length, undefined when it is gone.
 *
 * A function with no entry of its own borrows an orphan of the same metric that allows at least its score: one in the
 * same file (a rename), else one of the same name in another (a move, a `git mv`, a split). A file past its entry, or
 * over the cap with none, borrows the excess from a file entry the tree holds less than: preferring the same file name
 * gone (a `git mv`), then the same directory (a split). What is lent is what tighten moves (ratchet.mjs).
 */
export const judge = ({ items, baseline, measuredPath, metrics, linesOf, fileCap = CAPS.file }) => {
    const entries = [...baseline].map(([key, allowance]) => ({ key, allowance, ...partsOf(key) })).filter((entry) => metrics.has(entry.metric));
    const { keyed, fresh, claimed } = keyAll(items, entries, baseline);
    const lent = new Map();
    lendOrphans(
        keyed,
        fresh,
        entries.filter((entry) => entry.metric !== `file` && !claimed.has(entry.key) && measuredPath(entry.path, entry.metric)),
        lent,
    );
    const donors = entries
        .filter((entry) => entry.metric === `file`)
        .map((entry) => ({ ...entry, gone: linesOf(entry.path) === undefined, slack: entry.allowance - (linesOf(entry.path) ?? 0) }));
    lendSlack(keyed, donors, baseline, fileCap, lent);
    return { keyed, lent };
};

const METRIC_WORDS = { lines: `lines long`, cyclomatic: `cyclomatic complexity`, cognitive: `cognitive complexity` };

/** One finding, anchored `path:line` with the numbers standing alone, so the push check can match it across edits. */
export const findingOf = (item, allowed, fileCap = CAPS.file) => {
    if (item.metric === `file`) {
        return allowed === 0
            ? `${item.path}:1  ${item.value} lines in a file with no baseline entry, over the cap of ${fileCap}`
            : `${item.path}:1  ${item.value} lines, past its baseline of ${allowed}`;
    }
    const what = item.metric === `lines` ? `${item.value} lines long` : `${METRIC_WORDS[item.metric]} ${item.value}`;
    const cap = item.metric === `lines` ? `over the cap of ${CAPS.lines} lines with no baseline entry` : `over the plugin's cap with no baseline entry`;
    return `${item.path}:${item.line}  \`${item.symbol}\` ${what}, ${allowed === 0 ? cap : `past its baseline of ${allowed}`}`;
};
