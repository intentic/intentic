import { spawn } from "node:child_process";
import { scannerPruneGlobs } from "@intentic/workspace-ignore";
import type { WorkspaceSearchSpan } from "@intentic/sandbox-contract";
import type { EngineHit } from "../types.js";
import { DENIED_GLOBS } from "../workspace/floor.js";

// Matching lines kept per file; rg reads one more to tell an exact-cap file from one with more.
const MAX_PER_FILE = 50;
// Long lines are shipped as a window around the match so one hit can't eat the whole budget.
const SNIPPET_MAX = 200;
const SNIPPET_LEAD = 40;

export interface RgOptions {
    readonly root: string;
    readonly pattern: string;
    readonly literal?: boolean;
    readonly word?: boolean;
    readonly caseSensitive?: boolean;
    readonly ignored?: boolean;
    // The sweep's admitted paths, the authority on what may be surfaced; rg's own ignore handling is pruning only.
    readonly allowed: ReadonlySet<string>;
    readonly rgPath?: string;
    // Kills the rg child when the caller's request dies, so a superseded search doesn't keep burning CPU.
    readonly signal?: AbortSignal;
    // Stops the scan early, in these two units; ask for one past the page to tell a full page from a last page.
    readonly maxHits?: number;
    readonly maxFiles?: number;
    // Empty means nothing survived the filter; undefined means the whole tree; stays path-sorted when ceilinged.
    readonly paths?: readonly string[];
}

interface RgMatchData {
    readonly path: { readonly text: string };
    readonly line_number: number;
    readonly lines: { readonly text?: string };
    readonly submatches: readonly { readonly start: number; readonly end: number }[];
}

// UTF-8 byte width of one code point; the arithmetic Buffer.byteLength does, without allocating a Buffer per character.
const utf8Width = (code: number): number => (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x1_0000 ? 3 : 4);

// rg reports byte offsets into the line; this converts to JS string offsets in one forward walk, not a decode per
// offset, since a line can carry thousands of submatches and run to 1 MB.
const charSpans = (text: string, spans: readonly WorkspaceSearchSpan[]): WorkspaceSearchSpan[] => {
    // All-ASCII needs no conversion, but spans are still rebuilt so nothing extra from rg's JSON survives.
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
    // Anything the walk never reached points past the line, clamped to its end.
    for (; next < wanted.length; next += 1) {
        chars.set(wanted[next]!, text.length);
    }
    return spans.map((span) => ({ start: chars.get(span.start)!, end: chars.get(span.end)! }));
};

// The slice of a long line worth shipping, anchored on its first match; surviving spans are rebased onto it, and one
// clipped in half is dropped.
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
    // Files that had more matching lines than MAX_PER_FILE; a caller counting these hits must add a "+".
    readonly capped: ReadonlySet<string>;
    // Cut short by maxHits/maxFiles, so every total is a floor; distinct from `capped`, a file with more than shown.
    readonly ceiling: boolean;
}

// Post-filter only, not a substitute for pruning; route real exclusions through scannerPruneGlobs instead.
const BEGIN_EVENT = '{"type":"begin"';
const MATCH_EVENT = '{"type":"match"';

// Content search via ripgrep --json, post-filtered against the sweep; hits come back sorted (path, line) since rg's own
// order is not. Streamed, not buffered: a broad query's JSON can run to tens of megabytes.
export const rgSearch = async (options: RgOptions): Promise<RgResult> => {
    // Empty paths means nothing survived the filter; scanning `./` here would read as the whole workspace instead.
    if (options.paths?.length === 0) {
        return { hits: [], capped: new Set(), ceiling: false };
    }
    const args = ["--json", "--hidden", "--max-filesize", "1M", "--max-count", String(MAX_PER_FILE + 1), "--no-config", "--no-messages"];
    // Pruning only, `allowed` is the authority; DENIED_GLOBS never lift, even with --ignored.
    for (const glob of [...scannerPruneGlobs(options.ignored === true), ...DENIED_GLOBS]) {
        args.push("-g", glob);
    }
    // Always --no-ignore: rg's ignore handling reads sources the sweep does not and can silently disagree with it.
    args.push("--no-ignore");
    if (options.literal) {
        args.push("-F");
    }
    if (options.word) {
        args.push("-w");
    }
    // Insensitive unless asked, never rg's smart case (`-S`): a capital would silently narrow the search.
    args.push(options.caseSensitive ? "-s" : "-i");
    // A ceilinged scan must be deterministic; --sort path makes it so, since rg's parallel walk order is not.
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
    // Admitted files seen, against maxFiles; ceiling marks the child killed, so late buffered output is ignored.
    let files = 0;
    let ceiling = false;
    // Set when the hit ceiling lands mid-file, so the scan finishes that file rather than half-reporting it.
    let stopAtNextFile = false;

    const child = spawn(options.rgPath ?? "rg", args, {
        cwd: options.root,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    // Reached the ceiling: kill the child; the `close` handler treats a signal-killed child as the caller's own abort.
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
        // The cap+1st line is read only to learn it exists (50 matches vs 50-of-more); it never reaches a caller.
        if (kept >= MAX_PER_FILE) {
            capped.add(path);
            return;
        }
        const text = data.lines.text?.replace(/\r?\n$/, "");
        if (text === undefined || data.submatches.length === 0) {
            return;
        }
        kept += 1;
        // Every occurrence on the line is kept, not just the first; a client marks them all.
        const snippet = window(text, charSpans(text, data.submatches));
        hits.push({ path, line: data.line_number, text: snippet.text, spans: snippet.spans, tags: [{ kind: "text" }] });
        if (options.maxHits !== undefined && hits.length >= options.maxHits) {
            stopAtNextFile = true;
        }
    };

    // Read only for the message on a failing exit; capped so a chatty rg cannot accumulate unboundedly.
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
            // Exit 1 means no matches; anything higher is a real error; a null code means a signal, the caller's own
            // abort.
            if (code !== null && code > 1) {
                reject(new Error(`ripgrep: ${stderr.trim() || "search failed"}`));
                return;
            }
            resolve();
        });
    });
    return { hits: hits.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line)), capped, ceiling };
};
