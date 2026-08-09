import { execFile } from "node:child_process";
import { type FileHandle, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { LogFileEntry } from "@intentic/sandbox-contract";
import { resolveWithin } from "../workspace/workspace-files.js";

// Daemon-owned debug logs under historyRoot/logs: terminal pipe-pane captures (terminals/), intentic CLI run
// logs (intentic-runs/), the daemon's own pino file (daemon.log), and its resource time series
// (resource-metrics.jsonl). Living under historyRoot keeps them outside the agent's /work mount — the same
// placement rationale as activity.jsonl.

// Prune policy: copy-truncate any file past MAX_FILE_BYTES to its newest TAIL_BYTES (safe under the writers'
// O_APPEND fds — later appends land after the rewritten tail), drop files idle past MAX_AGE_MS, and cap the
// tree at MAX_FILES newest-first.
const MAX_FILE_BYTES = 5_000_000;
const TAIL_BYTES = 1_000_000;
const MAX_AGE_MS = 30 * 24 * 3_600_000;
const MAX_FILES = 100;

export const logsRoot = (historyRoot: string): string => join(historyRoot, "logs");

const walkFiles = async (root: string): Promise<string[]> => {
    try {
        const entries = await readdir(root, { recursive: true, withFileTypes: true });
        // Skip pane-log-clean's atomic-rename scratch files (terminals/*.log.tmp) — not real log files.
        return entries.filter((entry) => entry.isFile() && !entry.name.endsWith(".tmp")).map((entry) => join(entry.parentPath, entry.name));
    } catch {
        return [];
    }
};

// Every log file under the root, newest first; names are root-relative posix paths (the /logs route contract).
export const listLogFiles = async (root: string): Promise<LogFileEntry[]> => {
    const files = await Promise.all(
        (await walkFiles(root)).map(async (path) => {
            try {
                const info = await stat(path);
                return { name: relative(root, path).split(sep).join("/"), sizeBytes: info.size, modifiedAt: Math.round(info.mtimeMs) };
            } catch {
                // Raced a prune delete — the file is simply gone.
                return undefined;
            }
        }),
    );
    return files.filter((file) => file !== undefined).toSorted((a, b) => b.modifiedAt - a.modifiedAt);
};

// The newest `bytes` of a log file; undefined for a missing file or a name escaping the root (→ 404).
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
            .filter((file) => file.size > MAX_FILE_BYTES)
            .map(async (file) => {
                // ponytail: read-then-rewrite drops appends racing the rewrite — fine for debug logs at a 5MB cap.
                const tail = (await readFile(file.path)).subarray(-TAIL_BYTES);
                await writeFile(file.path, tail);
            }),
    );
};

// Every tmux pane's output piped to its own file, via global hooks — per-spawn pipe-pane would miss
// agent-created sessions, extra windows, and splits. The stream is replayed through pane-log-clean (a
// headless VT emulator, on PATH in the image) which owns the file and rewrites the rendered screen, so
// the persisted log is what the terminal actually showed — not raw escape/redraw noise. Pane width and
// height are passed so wrapping and cursor math match the pane. The session name is format-sanitized (it
// is interpolated into a shell command); the pane id keeps names unique.
const pipeHook = (dir: string): string =>
    `pipe-pane -o "mkdir -p ${dir}; exec pane-log-clean ${dir}/#{s|[^a-zA-Z0-9_.-]|_|:session_name}-#{pane_id}.log #{pane_width} #{pane_height}"`;

// Also the INTENTIC_TERMINAL_LOGS_DIR contract (main.ts): bin/tmux-run composes `$dir/$session-$pane.log`
// from it so the output filter's footer can point the agent at the pane's raw log.
export const terminalLogsDir = (historyRoot: string): string => join(logsRoot(historyRoot), "terminals");

const tmuxLogHooks = (historyRoot: string): string[][] => {
    const dir = terminalLogsDir(historyRoot);
    return ["session-created", "after-new-window", "after-split-window"].map((hook) => ["set-hook", "-g", hook, pipeHook(dir)]);
};

// Re-arm the hooks on a tmux server that outlived a daemon restart — best-effort; the image's tmux.conf
// (Dockerfile) covers server start, and this is a no-op failure without tmux (local dev, tests).
export const applyTmuxLogHooks = async (historyRoot: string): Promise<void> => {
    for (const args of tmuxLogHooks(historyRoot)) {
        await promisify(execFile)("tmux", args).catch(() => undefined);
    }
};
