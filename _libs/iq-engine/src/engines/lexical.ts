import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import type { EngineHit } from "../types.js";
import { IQ_DIR } from "../workspace/floor.js";

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
}

interface RgMatchData {
    readonly path: { readonly text: string };
    readonly line_number: number;
    readonly lines: { readonly text?: string };
    readonly submatches: readonly { readonly start: number; readonly end: number }[];
}

const window = (line: string, start: number, end: number): { text: string; start: number; end: number } => {
    if (line.length <= SNIPPET_MAX) {
        return { text: line, start, end };
    }
    const from = Math.max(0, start - SNIPPET_LEAD);
    return { text: line.slice(from, from + SNIPPET_MAX), start: start - from, end: Math.min(end - from, SNIPPET_MAX) };
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
    args.push("-g", `!${IQ_DIR}`);
    if (options.ignored) {
        args.push("--no-ignore");
    }
    if (options.literal) {
        args.push("-F");
    }
    if (options.word) {
        args.push("-w");
    }
    args.push(options.caseSensitive ? "-s" : "-S");
    args.push("-e", options.pattern, "./");
    const { stdout } = await exec(options.rgPath ?? "rg", args, { cwd: options.root, maxBuffer: 64 * 1024 * 1024 }).catch(
        (error: Error & { code?: unknown; stdout?: string; stderr?: string }) => {
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
        },
    );
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
        const sub = event.data.submatches[0];
        if (text === undefined || sub === undefined) {
            continue;
        }
        const snippet = window(text, sub.start, sub.end);
        hits.push({ path, line: event.data.line_number, text: snippet.text, start: snippet.start, end: snippet.end, tags: [{ kind: "text" }] });
    }
    return hits.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
};
