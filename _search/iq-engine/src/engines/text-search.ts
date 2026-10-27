import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkspaceSearchGroup, WorkspaceSearchHit } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";
import { scannerPruneGlobs } from "@intentic/workspace-ignore";
import { GREP_DIALECT, GREP_DIALECT_NOTE } from "../verbs/hints.js";
import { DENIED_GLOBS, isIqDenied } from "../workspace/floor.js";
import { globToRegExp } from "../workspace/glob.js";
import { charSpans, MAX_PER_FILE, snippetWindow } from "./lexical.js";

// A search box's text search, the one a person waits on: ripgrep walking the tree itself, in parallel, rather than over
// the resident index's sweep (lexical.ts, which `iq find` keeps). Nothing here needs the index, so it runs wherever its
// caller does: the daemon starts it at the daemon's own priority, not the engine child's, and an engine that is
// starting, indexing or answering a turn's lookups does not hold it up.
//
// The walk admits what the sweep admits (scan.ts, workspace-ignore): every .gitignore at or below the root, whether or
// not it is a repository; nothing from the global excludes, `.git/info/exclude` or `.ignore` files; the junk folders,
// the reference shelf and agent worktrees pruned; dotfiles in. The engine's floor (isIqDenied) is the gate on what comes
// back, whatever the walk let through, and `ignored` never lifts it.

// Lines kept in all before the scan stops, the file it is in finished first: ten of the search box's pages. VSCode stops
// at 20,000 (search.maxResults); here a broad pattern ("e", "const") took about twice as long to reach that many lines
// as this many (120 against 240 ms on /work, measured 2026-10-26), all of it before the first page could be answered.
export const TEXT_MAX_HITS = 10_000;
// A file past this is data, not text anyone searches by hand; the same bound `iq find` reads with.
const MAX_FILE_SIZE = "1M";

export interface TextScanOptions {
    readonly root: string;
    readonly pattern: string;
    readonly literal?: boolean | undefined;
    readonly word?: boolean | undefined;
    readonly caseSensitive?: boolean | undefined;
    // Into node_modules, build output and everything a .gitignore names; the floor still holds.
    readonly ignored?: boolean | undefined;
    // Root-relative subtrees (or files) to look in; undefined is the whole root, empty is nothing at all.
    readonly paths?: readonly string[] | undefined;
    // The files-to-include box, as globs over root-relative paths (search-globs.ts): any one must match (none given
    // admits every file), none of these.
    readonly globs?: readonly string[] | undefined;
    readonly notGlobs?: readonly string[] | undefined;
    // Lines kept before the scan stops; the file it is in is finished, so no file is ever half-reported.
    readonly maxHits?: number | undefined;
    readonly rgPath?: string | undefined;
    // The caller letting go: the rg child is killed, so a superseded search stops spending the machine.
    readonly signal?: AbortSignal | undefined;
    // Each file as soon as all of its lines are in, in the order rg finishes them (not path order).
    readonly onGroup?: ((group: WorkspaceSearchGroup) => void) | undefined;
}

export interface TextScan {
    // Every file with a match, in path order.
    readonly groups: readonly WorkspaceSearchGroup[];
    // Stopped at maxHits: every count is a floor, and more files may match than are here.
    readonly ceiling: boolean;
    // Milliseconds from the start to the first file's lines being in; undefined when nothing matched.
    readonly firstMs: number | undefined;
    // What rg said about a file it could not read, when the scan went on without it.
    readonly unreadable: string | undefined;
}

// Ignore-file sources beyond the sweep's own, switched off so the two cannot disagree (see the head of this file).
const WALK_ARGS = ["--no-config", "--hidden", "--no-ignore-global", "--no-ignore-exclude", "--no-ignore-dot", "--no-require-git"];

export class TextPatternError extends Error {}

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        // allow(silent-catch): a missing file is the answer, not a failure.
        return false;
    }
};

// Whether any directory above the root holds a .gitignore. rg reads the ignore files above every path it is given, past
// the root too, so a subtree can be handed to rg directly (sparing the walk of everything beside it) only when nothing
// above the root has rules to add; otherwise the whole root is walked with parents off and narrowed afterwards.
const ignoresAboveRoot = async (root: string): Promise<boolean> => {
    for (let dir = dirname(root); ; dir = dirname(dir)) {
        if (await exists(join(dir, ".gitignore"))) {
            return true;
        }
        if (dirname(dir) === dir) {
            return false;
        }
    }
};

const normalized = (path: string): string => path.replace(/^\.\//, "").replace(/\/+$/, "");

// Where rg is pointed: the subtrees themselves when that is exact, else the root with parents off. Narrowed paths that
// do not exist are dropped, since rg exits 2 on one, which would read as a failed search.
const targetsOf = async (options: TextScanOptions, prefixes: readonly string[] | undefined): Promise<{ args: string[]; paths: string[] }> => {
    if (prefixes === undefined) {
        return { args: options.ignored === true ? [] : ["--no-ignore-parent"], paths: ["./"] };
    }
    const found = await Promise.all(prefixes.map(async (path) => ((await exists(join(options.root, path))) ? path : undefined)));
    const given = found.filter((path): path is string => path !== undefined);
    if (given.length === 0 || options.ignored === true) {
        return { args: [], paths: given };
    }
    return (await ignoresAboveRoot(options.root)) ? { args: ["--no-ignore-parent"], paths: ["./"] } : { args: [], paths: given };
};

// What every run asks of rg besides where to look: the walk, the bounds, the pattern and its switches.
const argsOf = (options: TextScanOptions): string[] => {
    const args = ["--json", ...WALK_ARGS, "--max-filesize", MAX_FILE_SIZE, "--max-count", String(MAX_PER_FILE + 1)];
    if (options.ignored === true) {
        args.push("--no-ignore");
    }
    // Pruning only: the walk skips what the post-filter would drop anyway. rg anchors globs at its working directory,
    // the root, whatever paths it is given.
    for (const glob of [...scannerPruneGlobs(options.ignored === true), ...DENIED_GLOBS]) {
        args.push("-g", glob);
    }
    if (options.literal === true) {
        args.push("-F");
    }
    if (options.word === true) {
        args.push("-w");
    }
    // Any case unless asked, never rg's smart case, where a capital would narrow the search unasked.
    args.push(options.caseSensitive === true ? "-s" : "-i", "-e", options.pattern);
    return args;
};

// Which found files the caller may have: the floor first, then the scope it asked for.
const admitterOf = (options: TextScanOptions, prefixes: readonly string[] | undefined): ((path: string) => boolean) => {
    const globs = options.globs?.map(globToRegExp);
    const notGlobs = options.notGlobs?.map(globToRegExp) ?? [];
    const inPrefix = (path: string): boolean => prefixes === undefined || prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    const included = (path: string): boolean => globs === undefined || globs.length === 0 || globs.some((glob) => glob.test(path));
    return (path) => !isIqDenied(path) && inPrefix(path) && included(path) && !notGlobs.some((glob) => glob.test(path));
};

interface RgEvent {
    readonly type: string;
    readonly data: {
        readonly path?: { readonly text?: string };
        readonly line_number?: number;
        readonly lines?: { readonly text?: string };
        readonly submatches?: readonly { readonly start: number; readonly end: number }[];
    };
}

interface OpenFile {
    readonly path: string;
    readonly hits: WorkspaceSearchHit[];
    capped: boolean;
}

// rg's events folded into files: rg prints each file's events together, so a file is complete at its `end`. `onEvent`
// answers false once the ceiling is reached and the file it landed in is finished.
const collectorOf = (admits: (path: string) => boolean, maxHits: number, onGroup: ((group: WorkspaceSearchGroup) => void) | undefined) => {
    const from = performance.now();
    const groups: WorkspaceSearchGroup[] = [];
    let open: OpenFile | undefined;
    let kept = 0;
    let firstMs: number | undefined;
    const begin = (event: RgEvent): void => {
        const printed = event.data.path?.text;
        const path = printed === undefined ? undefined : normalized(printed);
        open = path !== undefined && admits(path) ? { path, hits: [], capped: false } : undefined;
    };
    const end = (file: OpenFile): boolean => {
        open = undefined;
        if (file.hits.length === 0) {
            return true;
        }
        const group: WorkspaceSearchGroup = { path: file.path, score: file.hits.length, hits: file.hits };
        if (file.capped) {
            group.capped = true;
        }
        firstMs ??= performance.now() - from;
        groups.push(group);
        onGroup?.(group);
        return kept < maxHits;
    };
    const match = (file: OpenFile, event: RgEvent): void => {
        // The cap+1st line is read only to learn the file has more than it keeps.
        if (file.hits.length >= MAX_PER_FILE) {
            file.capped = true;
            return;
        }
        const text = event.data.lines?.text?.replace(/\r?\n$/, "");
        const submatches = event.data.submatches ?? [];
        if (text === undefined || submatches.length === 0) {
            return;
        }
        const snippet = snippetWindow(text, charSpans(text, submatches));
        file.hits.push({ line: event.data.line_number ?? 0, text: snippet.text, spans: snippet.spans, tags: [{ kind: "text" }] });
        kept += 1;
    };
    return {
        onEvent: (event: RgEvent): boolean => {
            if (event.type === "begin") {
                begin(event);
            } else if (open !== undefined && event.type === "end") {
                return end(open);
            } else if (open !== undefined && event.type === "match") {
                match(open, event);
            }
            return true;
        },
        groups,
        firstMs: (): number | undefined => firstMs,
    };
};

interface RgRun {
    // Stopped by `onLine` answering false, not by rg finishing.
    readonly stopped: boolean;
    // rg's own: 0 found, 1 found nothing, 2 something went wrong (the pattern, or one file it could not read).
    readonly code: number;
    readonly stderr: string;
}

// One rg child, its stdout read a line at a time until `onLine` answers false, when the child is killed.
const runRg = (
    rgPath: string,
    root: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
    onLine: (line: string) => boolean,
): Promise<RgRun> =>
    new Promise<RgRun>((resolve, reject) => {
        const child = spawn(rgPath, args, { cwd: root, signal });
        // Nothing is ever searched from stdin; closed at once, a `-` among the paths reads as empty.
        child.stdin.end();
        let stopped = false;
        // Kept short: read for the reason a failing run gives, and for the file a finished one could not read.
        let stderr = "";
        let carry = "";
        const take = (line: string): void => {
            if (!stopped && line !== "" && !onLine(line)) {
                stopped = true;
                child.kill();
            }
        };
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            stderr = (stderr + chunk).slice(0, 2_000);
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            const lines = (carry + chunk).split("\n");
            // The last piece is whatever the chunk boundary cut in half, held back for the next one.
            carry = lines.pop() ?? "";
            lines.forEach(take);
        });
        child.on("error", (error: Error & { code?: unknown }) => {
            reject(error.code === "ENOENT" ? new Error("ripgrep (rg) not found on PATH, install ripgrep or set IQ_RG_PATH") : error);
        });
        child.on("close", (code, killedBy) => {
            take(carry);
            if (stopped) {
                resolve({ stopped, code: code ?? 0, stderr });
            } else if (code === null) {
                // Not the ceiling's own kill (the caller's abort has already rejected through `error`): what it found
                // must not read as the whole answer.
                reject(new Error(`ripgrep: killed by ${killedBy ?? "a signal"} before the search finished`));
            } else {
                resolve({ stopped, code, stderr });
            }
        });
    });

// Whether rg refuses the pattern itself (look-around, a backreference, a typo), told by its exit code rather than its
// words, as the desktop's folder search tells it (local-files search-rg.ts): asked of nothing (its stdin, closed at
// once), a pattern it reads matches nothing and exits 1, and one it cannot read exits 2 before reading anything.
const refusesPattern = async (options: TextScanOptions): Promise<boolean> => {
    const args = ["--no-config"];
    if (options.literal === true) {
        args.push("-F");
    }
    if (options.word === true) {
        args.push("-w");
    }
    args.push("-e", options.pattern, "-");
    return (await runRg(options.rgPath ?? "rg", options.root, args, options.signal, () => true)).code === 2;
};

// One ripgrep run over the scope, each file handed to `onGroup` as it completes and all of them returned in path order.
export const scanText = async (options: TextScanOptions): Promise<TextScan> => {
    const prefixes = options.paths?.map(normalized);
    const targets = await targetsOf(options, prefixes);
    if (targets.paths.length === 0) {
        return { groups: [], ceiling: false, firstMs: undefined, unreadable: undefined };
    }
    const collector = collectorOf(admitterOf(options, prefixes), options.maxHits ?? TEXT_MAX_HITS, options.onGroup);
    const args = [...argsOf(options), ...targets.args, "--", ...targets.paths];
    const run = await runRg(options.rgPath ?? "rg", options.root, args, options.signal, (line) => {
        try {
            // SAFETY: rg --json prints one event object per line; every field read off it is optional above.
            return collector.onEvent(JSON.parse(line) as RgEvent);
        } catch {
            // allow(silent-catch): a line that is not one of rg's events carries no match.
            return true;
        }
    });
    // 2 is rg's "something went wrong": the pattern itself, or a file it could not read with the rest searched.
    if (!run.stopped && run.code === 2 && (await refusesPattern(options))) {
        throw new TextPatternError(run.stderr.trim());
    }
    const unreadable = run.stderr.trim().split("\n")[0];
    return {
        groups: collector.groups.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        ceiling: run.stopped,
        firstMs: collector.firstMs(),
        unreadable: unreadable === "" ? undefined : unreadable,
    };
};

export interface TextFind extends TextScan {
    // What was done unasked: a pattern rg cannot read run as plain text, grep-style escapes rewritten.
    readonly note: string | undefined;
}

// A pattern rg cannot read runs again as plain text, as `iq find` does (dispatch.ts).
const scanOrLiteral = async (options: TextScanOptions): Promise<TextFind> => {
    try {
        return { ...(await scanText(options)), note: undefined };
    } catch (error) {
        if (options.literal === true || !(error instanceof TextPatternError)) {
            throw error;
        }
        return { ...(await scanText({ ...options, literal: true })), note: "pattern isn't valid rust regex: ran as literal text" };
    }
};

// Grep-style escapes rewritten to rust regex, run only once the pattern as written matched nothing; undefined when the
// rewrite does not read either or matches nothing too.
const rewrittenScan = async (options: TextScanOptions): Promise<TextFind | undefined> => {
    const rewritten = options.pattern.replaceAll(/\\([|+?(){}])/g, "$1");
    try {
        const retried = await scanText({ ...options, pattern: rewritten });
        return retried.groups.length > 0 ? { ...retried, note: `grep-style escapes rewritten to rust regex, matched: ${rewritten}` } : undefined;
    } catch (error) {
        // The rewrite can unbalance a group (`\(` alone becomes `(`); only that is a rewrite that did not take.
        if (error instanceof TextPatternError) {
            return undefined;
        }
        throw error;
    }
};

// A box's text search, with the recoveries `iq find` makes. Never an answer by meaning: a text box asked for the text,
// and none is the answer.
export const findText = async (options: TextScanOptions): Promise<TextFind> => {
    const found = await scanOrLiteral(options);
    if (options.literal === true || found.note !== undefined || !GREP_DIALECT.test(options.pattern)) {
        return found;
    }
    const rewritten = found.groups.length === 0 ? await rewrittenScan(options) : undefined;
    // Said even when it matched, so a false positive does not teach the wrong pattern.
    return rewritten ?? { ...found, note: GREP_DIALECT_NOTE };
};
