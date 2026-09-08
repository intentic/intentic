import { execFile } from "node:child_process";
import { type FileHandle, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { LogFileEntry } from "@intentic/sandbox-contract";
import { resolveWithin } from "../workspace/files/workspace-files-paths.js";

// Daemon-owned debug logs under historyRoot/logs: terminal captures (terminals/), intentic CLI runs (intentic-runs/),
// daemon.log, and resource-metrics.jsonl. Kept under historyRoot, outside the agent's /work mount.

// Prune policy:
// - truncate a file over its cap to its newest tail (safe under append-only writers)
// - drop files idle past MAX_AGE_MS
// - keep only the newest MAX_FILES
const MAX_FILE_BYTES = 5_000_000;
const TAIL_BYTES = 1_000_000;
const MAX_AGE_MS = 30 * 24 * 3_600_000;
const MAX_FILES = 100;

// resource-metrics.jsonl only (exact name, not extension): default caps would hold under a day of samples.
const FILE_CAPS: Readonly<Record<string, { readonly maxBytes: number; readonly tailBytes: number }>> = {
    "resource-metrics.jsonl": { maxBytes: 40_000_000, tailBytes: 30_000_000 },
};

const capFor = (root: string, path: string): { readonly maxBytes: number; readonly tailBytes: number } =>
    FILE_CAPS[relative(root, path).split(sep).join("/")] ?? { maxBytes: MAX_FILE_BYTES, tailBytes: TAIL_BYTES };

export const logsRoot = (historyRoot: string): string => join(historyRoot, "logs");

const walkFiles = async (root: string): Promise<string[]> => {
    try {
        const entries = await readdir(root, { recursive: true, withFileTypes: true });
        // Skip pane-log-clean's atomic-rename scratch files (terminals/*.log.tmp), not real log files.
        return entries.filter((entry) => entry.isFile() && !entry.name.endsWith(".tmp")).map((entry) => join(entry.parentPath, entry.name));
    } catch {
        return [];
    }
};

// Every log file under root, newest first, named as root-relative posix paths for the /logs route.
export const listLogFiles = async (root: string): Promise<LogFileEntry[]> => {
    const files = await Promise.all(
        (await walkFiles(root)).map(async (path) => {
            try {
                const info = await stat(path);
                return { name: relative(root, path).split(sep).join("/"), sizeBytes: info.size, modifiedAt: Math.round(info.mtimeMs) };
            } catch {
                // Raced a prune delete, the file is simply gone.
                return undefined;
            }
        }),
    );
    return files.filter((file) => file !== undefined).toSorted((a, b) => b.modifiedAt - a.modifiedAt);
};

// Newest `bytes` of a log file; undefined for a missing file or a name that escapes root (404).
export const tailLogFile = async (root: string, name: string, bytes: number): Promise<{ sizeBytes: number; text: string } | undefined> => {
    const target = resolveWithin(root, name);
    if (target === undefined) {
        return undefined;
    }
    let handle: FileHandle;
    try {
        handle = await open(target, "r");
    } catch {
        return undefined;
    }
    try {
        const size = (await handle.stat()).size;
        const length = Math.min(bytes, size);
        const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
        return { sizeBytes: size, text: buffer.toString("utf8") };
    } finally {
        await handle.close();
    }
};

export const pruneLogFiles = async (root: string): Promise<void> => {
    const files: { path: string; size: number; mtimeMs: number }[] = [];
    for (const path of await walkFiles(root)) {
        try {
            const info = await stat(path);
            files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
        } catch {
            // Already gone.
        }
    }
    const now = Date.now();
    const live = files.filter((file) => now - file.mtimeMs <= MAX_AGE_MS).toSorted((a, b) => b.mtimeMs - a.mtimeMs);
    const evicted = files.filter((file) => now - file.mtimeMs > MAX_AGE_MS).concat(live.splice(MAX_FILES));
    await Promise.all(evicted.map((file) => rm(file.path, { force: true })));
    await Promise.all(
        live
            .filter((file) => file.size > capFor(root, file.path).maxBytes)
            .map(async (file) => {
                // Read-then-rewrite can drop an append racing the rewrite; acceptable for debug logs at these caps.
                const tail = (await readFile(file.path)).subarray(-capFor(root, file.path).tailBytes);
                await writeFile(file.path, tail);
            }),
    );
};

// Global tmux hooks pipe every pane through pane-log-clean, which owns the file and renders the screen instead of raw
// escapes. Session name is sanitized; paired with pane id for a unique file name.
const pipeHook = (dir: string): string =>
    `pipe-pane -o "mkdir -p ${dir}; exec pane-log-clean ${dir}/#{s|[^a-zA-Z0-9_.-]|_|:session_name}-#{pane_id}.log #{pane_width} #{pane_height}"`;

// Matches INTENTIC_TERMINAL_LOGS_DIR (main.ts); bin/tmux-run composes `$dir/$session-$pane.log` from it for the output
// filter's footer.
export const terminalLogsDir = (historyRoot: string): string => join(logsRoot(historyRoot), "terminals");

const tmuxLogHooks = (historyRoot: string): string[][] => {
    const dir = terminalLogsDir(historyRoot);
    return ["session-created", "after-new-window", "after-split-window"].map((hook) => ["set-hook", "-g", hook, pipeHook(dir)]);
};

// Re-arms hooks on a tmux server that outlived a daemon restart; tmux.conf (Dockerfile) covers server start.
// Best-effort no-op when tmux is absent (local dev, tests).
export const applyTmuxLogHooks = async (historyRoot: string): Promise<void> => {
    for (const args of tmuxLogHooks(historyRoot)) {
        await promisify(execFile)("tmux", args).catch(() => undefined);
    }
};
