import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import type { WorkspaceSearchSpan } from "@intentic/sandbox-contract";
import type { EngineHit } from "../types.js";
import { DENIED_GLOBS } from "../workspace/floor.js";

const exec = promisify(execFile);

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
    // The sweep's admitted paths — the authority on what may be surfaced. rg's own ignore handling is pruning only.
    readonly allowed: ReadonlySet<string>;
    readonly rgPath?: string;
    // Kills the rg child when the caller's request dies (a superseded panel search must not keep burning CPU).
    readonly signal?: AbortSignal;
}

interface RgMatchData {
    readonly path: { readonly text: string };
    readonly line_number: number;
    readonly lines: { readonly text?: string };
    readonly submatches: readonly { readonly start: number; readonly end: number }[];
}

/* rg reports BYTE offsets into the line; a span has to index the JS string the client renders. On an ASCII line
 * the two agree, which is why this was invisible until a match sat after an em dash — every offset then points
 * that many bytes too far right, and the mark lands off the word. */
const charSpans = (text: string, spans: readonly WorkspaceSearchSpan[]): WorkspaceSearchSpan[] => {
    const bytes = Buffer.from(text, "utf8");
    // An all-ASCII line is the common case and needs no conversion — but it still gets rebuilt, so the spans
    // that leave here are ours and carry nothing else rg's JSON happened to attach to them.
    if (bytes.length === text.length) {
        return spans.map((span) => ({ start: span.start, end: span.end }));
    }
    const charAt = (byte: number): number => bytes.subarray(0, byte).toString("utf8").length;
    return spans.map((span) => ({ start: charAt(span.start), end: charAt(span.end) }));
};

// The slice of a long line worth shipping — anchored on its FIRST match — with every span that survives the cut
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

// Content search via ripgrep --json, post-filtered against the sweep. Hits come back sorted (path, line) — rg's
// parallel output order is nondeterministic, ours must not be.
export const rgSearch = async (options: RgOptions): Promise<EngineHit[]> => {
    const args = ["--json", "--hidden", "--max-filesize", "1M", "--max-count", String(MAX_PER_FILE), "--no-config", "--no-messages"];
    // Pruning only — the `allowed` post-filter is the authority. Junk dirs stay searchable under --ignored
    // (matching the sweep's layer semantics); .git and the index dir never do.
    for (const dir of options.ignored ? [".git"] : [...IGNORED_DIRS, ".git"]) {
        args.push("-g", `!**/${dir}`);
    }
    for (const glob of DENIED_GLOBS) {
        args.push("-g", glob);
    }
    // ALWAYS --no-ignore: rg's own ignore handling reads sources the sweep does not (git's info/exclude, nested
    // repo boundaries), and when the two disagreed rg won — silently. That is how a workspace whose code sits
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
    args.push("-e", options.pattern, "./");
    const { stdout } = await exec(options.rgPath ?? "rg", args, {
        cwd: options.root,
        maxBuffer: 64 * 1024 * 1024,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }).catch((error: Error & { code?: unknown; stdout?: string; stderr?: string }) => {
        // Exit 1 = no matches. Other numeric exits = real error (e.g. bad pattern) — surface rg's own message.
        if (error.code === 1) {
            return { stdout: error.stdout ?? "" };
        }
        if (typeof error.code === "number") {
            throw new Error(`ripgrep: ${(error.stderr ?? "").trim() || "search failed"}`);
        }
        if (error.code === "ENOENT") {
            throw new Error("iq: ripgrep (rg) not found on PATH — install ripgrep or set IQ_RG_PATH");
        }
        throw error;
    });
    const hits: EngineHit[] = [];
    for (const line of stdout.split("\n")) {
        if (line === "") {
            continue;
        }
        const event = JSON.parse(line) as { type: string; data: RgMatchData };
        if (event.type !== "match") {
            continue;
        }
        const path = event.data.path.text.replace(/^\.\//, "");
        if (!options.allowed.has(path)) {
            continue;
        }
        const text = event.data.lines.text?.replace(/\r?\n$/, "");
        if (text === undefined || event.data.submatches.length === 0) {
            continue;
        }
        // Every occurrence on the line, not just the first: a client marks them all, and dropping the rest is
        // what made a line with three hits look like it had one.
        const snippet = window(text, charSpans(text, event.data.submatches));
        hits.push({ path, line: event.data.line_number, text: snippet.text, spans: snippet.spans, tags: [{ kind: "text" }] });
    }
    return hits.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
};
