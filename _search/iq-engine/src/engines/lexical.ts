import { spawn } from "node:child_process";
import { scannerPruneGlobs } from "@intentic/workspace-ignore";
import type { WorkspaceSearchSpan } from "@intentic/sandbox-contract";
import type { EngineHit } from "../types.js";
import { DENIED_GLOBS } from "../workspace/floor.js";

/* How many matching lines one file may contribute. It exists so a single generated file can't crowd out the
 * rest of the workspace, and because it truncates, a caller that reports a total has to say the total is a
 * floor. `capped` below is that signal; rg is asked for one line past the cap purely so we can tell the file
 * that stopped exactly at 50 from the file that had more. */
const MAX_PER_FILE = 50;
// Long (e.g. minified) lines are shipped as a window around the match so one hit can't eat the whole budget.
const SNIPPET_MAX = 200;
const SNIPPET_LEAD = 40;

export interface RgOptions {
    readonly root: string;
    readonly pattern: string;
    readonly literal?: boolean;
    readonly word?: boolean;
    readonly caseSensitive?: boolean;
    readonly ignored?: boolean;
    // The sweep's admitted paths, the authority on what may be surfaced. rg's own ignore handling is pruning only.
    readonly allowed: ReadonlySet<string>;
    readonly rgPath?: string;
    // Kills the rg child when the caller's request dies (a superseded panel search must not keep burning CPU).
    readonly signal?: AbortSignal;
    /* THE SCAN'S OWN CEILING, in the two units a caller pages by, and the thing that makes a broad query cheap.
     *
     * Without one, a scan always runs to completion: a two-letter query built 124 455 hits across 4 578 files
     * so that a panel could show 1 000 of them, and read 1.4 GB of scanner JSON to do it. With one, the child
     * is KILLED the moment the ceiling is reached, which is what every editor's search does (VSCode stops at
     * 20 000 and cancels ripgrep). Measured on this workspace: 268 ms → 5 ms.
     *
     * Ask for one PAST the page you intend to show, the way MAX_PER_FILE asks rg for one line past its cap: a
     * scan that stopped at exactly the page size cannot tell a full page from a last page, and the panel's
     * Load-more would vanish while matches remained.
     *
     * Setting either one makes the scan SORTED (see below), because a ceiling turns "which hits" into a
     * question the answer depends on, and a search box must not answer it differently on two identical runs. */
    readonly maxHits?: number;
    readonly maxFiles?: number;
    /* Search these paths instead of the whole tree, for a query the caller has already narrowed.
     *
     * The pruning globs below only ever remove what the sweep would discard, so a NARROWED search (the panel's
     * files-to-include box, a `--lang`/`--only` filter) still walked the whole workspace and threw the surplus
     * away in the post-filter: the user's most obvious lever on a slow search did nothing at all for it.
     *
     * These are the sweep's own surviving entries, so they cannot be narrower than `allowed` — they ARE
     * `allowed`, which is why this needs no glob dialect translated into ripgrep's and cannot silently lose a
     * file the way a mistranslated glob would. Order matters and must stay the sweep's (path-sorted): with a
     * ceiling, ripgrep walks an explicit list in argument order, and that order decides which hits survive.
     *
     * Empty means "nothing survived the filter", answered without a scan. Undefined means the whole tree. */
    readonly paths?: readonly string[];
}

interface RgMatchData {
    readonly path: { readonly text: string };
    readonly line_number: number;
    readonly lines: { readonly text?: string };
    readonly submatches: readonly { readonly start: number; readonly end: number }[];
}

// UTF-8 width of one code point, by the ranges the encoding is defined over, the arithmetic Buffer.byteLength
// would do, without building a Buffer per character.
const utf8Width = (code: number): number => (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x1_0000 ? 3 : 4);

/* rg reports BYTE offsets into the line; a span has to index the JS string the client renders. On an ASCII line
 * the two agree, which is why this was invisible until a match sat after an em dash, every offset then points
 * that many bytes too far right, and the mark lands off the word.
 *
 * ONE forward walk for the whole line, not a decode per offset: a `--json` line may carry thousands of
 * submatches, and re-decoding the prefix for each of them is quadratic in a line rg is allowed to make 1 MB
 * long. Every wanted byte offset is collected, sorted, and read off a single cursor that advances a code point
 * at a time. */
const charSpans = (text: string, spans: readonly WorkspaceSearchSpan[]): WorkspaceSearchSpan[] => {
    // An all-ASCII line is the common case and needs no conversion, but the spans still get rebuilt, so the
    // ones that leave here are ours and carry nothing else rg's JSON happened to attach to them.
    if (Buffer.byteLength(text, "utf8") === text.length) {
        return spans.map((span) => ({ start: span.start, end: span.end }));
    }
    const wanted = [...new Set(spans.flatMap((span) => [span.start, span.end]))].toSorted((a, b) => a - b);
    const chars = new Map<number, number>();
    let byte = 0;
    let index = 0;
    let next = 0;
    while (index < text.length && next < wanted.length) {
        while (next < wanted.length && wanted[next]! <= byte) {
            chars.set(wanted[next]!, index);
            next += 1;
        }
        const code = text.codePointAt(index)!;
        byte += utf8Width(code);
        index += code < 0x1_0000 ? 1 : 2;
    }
    // Anything the walk never reached points past the line, clamped to its end, as an offset from a stale read
    // would be.
    for (; next < wanted.length; next += 1) {
        chars.set(wanted[next]!, text.length);
    }
    return spans.map((span) => ({ start: chars.get(span.start)!, end: chars.get(span.end)! }));
};

// The slice of a long line worth shipping, anchored on its FIRST match, with every span that survives the cut
// rebased onto it. A span the window clipped in half is dropped rather than shown ending mid-word.
const window = (line: string, spans: readonly WorkspaceSearchSpan[]): { text: string; spans: WorkspaceSearchSpan[] } => {
    if (line.length <= SNIPPET_MAX) {
        return { text: line, spans: [...spans] };
    }
    const from = Math.max(0, (spans[0]?.start ?? 0) - SNIPPET_LEAD);
    const to = from + SNIPPET_MAX;
    return {
        text: line.slice(from, to),
        spans: spans.filter((span) => span.start >= from && span.end <= to).map((span) => ({ start: span.start - from, end: span.end - from })),
    };
};

export interface RgResult {
    readonly hits: readonly EngineHit[];
    // Files that had more matching lines than MAX_PER_FILE. What a caller counting these hits must add a "+" to.
    readonly capped: ReadonlySet<string>;
    // The scan was cut short by maxHits/maxFiles, so files past the ceiling were never looked at and every
    // total derived from this is a floor. Distinct from `capped`, which is one file having more than it showed.
    readonly ceiling: boolean;
}

/* rg's JSON Lines stream is grouped per file, `begin`, that file's matches, then `end`, so which file the
 * lines belong to is known from the `begin` alone. That is what makes the sweep's post-filter affordable: rg's
 * pruning is coarser than the sweep's admitting (it prunes whole directories; the sweep also reads every
 * .gitignore layer), so a broad query still reports files the sweep will not surface, and this lets those be
 * dropped by a prefix comparison instead of a JSON.parse each.
 *
 * It is a post-filter, NOT a substitute for pruning. It used to be carrying the reference shelf: 1.4 GB of
 * events parsed and discarded on a two-letter query, because the prune list had never heard of it. Anything
 * the sweep rejects by RULE belongs in scannerPruneGlobs, where rg can skip the subtree instead of reading it
 * out loud for this loop to throw away. */
const BEGIN_EVENT = '{"type":"begin"';
const MATCH_EVENT = '{"type":"match"';

// Content search via ripgrep --json, post-filtered against the sweep. Hits come back sorted (path, line), rg's
// parallel output order is nondeterministic, ours must not be.
//
// STREAMED, not buffered: a broad query's JSON runs to tens of megabytes (40 MB for `test` in this workspace),
// and collecting it whole meant every two-letter query, the state the search box passes through on the way to
// every longer one, died on `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` instead of returning results.
export const rgSearch = async (options: RgOptions): Promise<RgResult> => {
    // A narrowed scope whose filter admitted nothing: there is no scan that could match, and `./` would be read
    // as "the whole workspace", which is the opposite of what was asked.
    if (options.paths?.length === 0) {
        return { hits: [], capped: new Set(), ceiling: false };
    }
    const args = ["--json", "--hidden", "--max-filesize", "1M", "--max-count", String(MAX_PER_FILE + 1), "--no-config", "--no-messages"];
    // Pruning only, the `allowed` post-filter is the authority. Derived from the ignore model itself rather than
    // listed here, so the junk dirs, the reference shelf and agent worktrees are pruned by the same rules that
    // decide the sweep, and `--ignored` lifts them all together. See scannerPruneGlobs for what that cost.
    // The index dir and the rest of the agent plane are the engine's own floor and never lift.
    for (const glob of [...scannerPruneGlobs(options.ignored === true), ...DENIED_GLOBS]) {
        args.push("-g", glob);
    }
    // ALWAYS --no-ignore: rg's own ignore handling reads sources the sweep does not (git's info/exclude, nested
    // repo boundaries), and when the two disagreed rg won, silently. That is how a workspace whose code sits
    // under a locally-excluded directory answered `files`/`ask` normally while every `find` returned zero. The
    // sweep decides what exists; rg only has to look, and IGNORED_DIRS above keeps it out of the expensive trees.
    args.push("--no-ignore");
    if (options.literal) {
        args.push("-F");
    }
    if (options.word) {
        args.push("-w");
    }
    // Insensitive unless asked, never ripgrep's smart case: `-S` made a capital in the query silently narrow the
    // search, which is the documented default's opposite and not what a search box's Aa switch means anywhere.
    args.push(options.caseSensitive ? "-s" : "-i");
    /* A ceilinged scan has to be DETERMINISTIC, and rg's default parallel walk is not: which 1 000 of 124 455
     * hits arrive first depends on thread scheduling, so the same query twice would show two different result
     * sets. `--sort path` makes the kept prefix the first N hits in path order, which is exactly the order the
     * panel's text scope displays anyway. It costs rg its parallelism, and with the shelf pruned that is
     * nothing: measured 5–38 ms ceilinged, 268 ms for the worst uncapped scan in this workspace.
     *
     * An explicit path list is walked in ARGUMENT order instead of being re-sorted, which is the same thing
     * here only because the list arrives path-sorted from the sweep (see RgOptions.paths). */
    const ceilinged = options.maxHits !== undefined || options.maxFiles !== undefined;
    if (ceilinged) {
        args.push("--sort", "path");
    }
    args.push("-e", options.pattern, "--", ...(options.paths ?? ["./"]));
    const hits: EngineHit[] = [];
    const capped = new Set<string>();
    // The file the stream is currently inside: whether the sweep admits it, and how many of its lines are kept.
    let admitted = false;
    let kept = 0;
    // Admitted files seen, against maxFiles; and whether a ceiling has already killed the child, after which
    // buffered output is still delivered by the stream and has to be ignored rather than half-parsed.
    let files = 0;
    let ceiling = false;
    /* The hit ceiling is reached mid-file, and stopping there would hand back a HALF-READ file: the same
     * "half a file's matches under its own header reads as the file having that many" a page is built to
     * avoid, and worse, because the caller pages by whole files, so its next page would start after the file
     * and the rest of those matches would exist in no page at all. So the ceiling waits for the next file
     * boundary. The overshoot is bounded by MAX_PER_FILE, and the boundary itself is the proof that there was
     * more to find, which is what `ceiling` then tells the pager. */
    let stopAtNextFile = false;

    const child = spawn(options.rgPath ?? "rg", args, {
        cwd: options.root,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    // Reached the ceiling: stop reading, and take the scan down with it. The `close` handler below treats a
    // signal-killed child as the caller's own abort already, so there is nothing else to unwind.
    const stop = (): void => {
        ceiling = true;
        child.kill();
    };

    const onLine = (line: string): void => {
        if (ceiling) {
            return;
        }
        if (line.startsWith(BEGIN_EVENT)) {
            const event = JSON.parse(line) as { data: { path: { text: string } } };
            admitted = options.allowed.has(event.data.path.text.replace(/^\.\//, ""));
            kept = 0;
            if (!admitted) {
                return;
            }
            files += 1;
            if (stopAtNextFile || (options.maxFiles !== undefined && files > options.maxFiles)) {
                stop();
                admitted = false;
            }
            return;
        }
        if (!admitted || !line.startsWith(MATCH_EVENT)) {
            return;
        }
        const { data } = JSON.parse(line) as { data: RgMatchData };
        const path = data.path.text.replace(/^\.\//, "");
        // The cap+1st line is read only to learn that it exists, it is the difference between "50 matches" and
        // "50 of more than 50", and it never reaches a caller.
        if (kept >= MAX_PER_FILE) {
            capped.add(path);
            return;
        }
        const text = data.lines.text?.replace(/\r?\n$/, "");
        if (text === undefined || data.submatches.length === 0) {
            return;
        }
        kept += 1;
        // Every occurrence on the line, not just the first: a client marks them all, and dropping the rest is
        // what made a line with three hits look like it had one.
        const snippet = window(text, charSpans(text, data.submatches));
        hits.push({ path, line: data.line_number, text: snippet.text, spans: snippet.spans, tags: [{ kind: "text" }] });
        if (options.maxHits !== undefined && hits.length >= options.maxHits) {
            stopAtNextFile = true;
        }
    };

    // Only ever read for the message on a failing exit; a rg that keeps talking must not accumulate unboundedly.
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(0, 2_000);
    });
    child.stdout.setEncoding("utf8");
    let carry = "";
    child.stdout.on("data", (chunk: string) => {
        const lines = (carry + chunk).split("\n");
        // The last piece is whatever the chunk boundary cut in half, held back for the next one.
        carry = lines.pop() ?? "";
        for (const line of lines) {
            onLine(line);
        }
    });
    await new Promise<void>((resolve, reject) => {
        child.on("error", (error: Error & { code?: unknown }) => {
            reject(error.code === "ENOENT" ? new Error("iq: ripgrep (rg) not found on PATH, install ripgrep or set IQ_RG_PATH") : error);
        });
        child.on("close", (code) => {
            if (carry !== "") {
                onLine(carry);
            }
            // Exit 1 = no matches. Anything above = a real error (e.g. bad pattern), surface rg's own message.
            // A null code means a signal killed it, which here is the caller's own abort.
            if (code !== null && code > 1) {
                reject(new Error(`ripgrep: ${stderr.trim() || "search failed"}`));
                return;
            }
            resolve();
        });
    });
    return { hits: hits.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line)), capped, ceiling };
};
