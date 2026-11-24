import type { WorkspaceSearchGroup, WorkspaceSearchHit } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";
import { charSpans, MAX_PER_FILE, snippetWindow } from "./snippet.js";
import { admitterOf, normalized, runRg, targetsOf, walkArgs, type WalkScope } from "./walk.js";

// A search box's text search, the one a person waits on: ripgrep walking the tree itself, in parallel. Nothing here needs
// an index, so it runs wherever its caller does: the daemon starts it at its own priority.
//
// The walk admits what the workspace tree admits (workspace-ignore): every .gitignore at or below the root, whether or
// not it is a repository; nothing from the global excludes, `.git/info/exclude` or `.ignore` files; the junk folders,
// the reference shelf and agent worktrees pruned; dotfiles in. The floor (isStateDenied) is the gate on what comes
// back, whatever the walk let through, and `ignored` never lifts it.

// Grep-escaped metachars rust regex takes literally: `a\|b` matches the text "a|b", not alternation.
const GREP_DIALECT = /\\[|+?(){}]/;
const GREP_DIALECT_NOTE = "pattern has grep-style escapes, search uses rust regex: alternation is a|b (no backslash); literal text: the literal switch";

// Lines kept in all before the scan stops, the file it is in finished first: ten of the search box's pages. VSCode stops
// at 20,000 (search.maxResults); here a broad pattern ("e", "const") took about twice as long to reach that many lines
// as this many (120 against 240 ms on /work, measured 2026-10-26), all of it before the first page could be answered.
export const TEXT_MAX_HITS = 10_000;
// A file past this is data, not text anyone searches by hand.
const MAX_FILE_SIZE = "1M";

export interface TextScanOptions extends WalkScope {
    readonly pattern: string;
    readonly literal?: boolean | undefined;
    readonly word?: boolean | undefined;
    readonly caseSensitive?: boolean | undefined;
    // Lines kept before the scan stops; the file it is in is finished, so no file is ever half-reported.
    readonly maxHits?: number | undefined;
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

export class TextPatternError extends Error {}

// What every run asks of rg besides where to look: the walk, the bounds, the pattern and its switches.
const argsOf = (options: TextScanOptions): string[] => {
    const args = ["--json", ...walkArgs(options), "--max-filesize", MAX_FILE_SIZE, "--max-count", String(MAX_PER_FILE + 1)];
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

// A pattern rg cannot read runs again as plain text.
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

// A box's text search, with its two recoveries: a pattern rg cannot read run as plain text, grep-style escapes rewritten
// once the pattern as written matched nothing.
export const findText = async (options: TextScanOptions): Promise<TextFind> => {
    const found = await scanOrLiteral(options);
    if (options.literal === true || found.note !== undefined || !GREP_DIALECT.test(options.pattern)) {
        return found;
    }
    const rewritten = found.groups.length === 0 ? await rewrittenScan(options) : undefined;
    // Said even when it matched, so a false positive does not teach the wrong pattern.
    return rewritten ?? { ...found, note: GREP_DIALECT_NOTE };
};
