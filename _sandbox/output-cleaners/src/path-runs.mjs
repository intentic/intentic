// Folds for output that repeats a path on every line: a run of bare paths said once per directory, and a run of grep
// hits said once per file. Lossless both ways, and each fold is taken only when it comes out smaller.

import { bodyBytes } from "./cleaner-shapes.mjs";

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

export const foldPathRuns = (lines) => {
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
    for (let start = 0; start < run.length;) {
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

export const foldHitRuns = (lines) => {
    const out = [];
    for (let i = 0; i < lines.length;) {
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
