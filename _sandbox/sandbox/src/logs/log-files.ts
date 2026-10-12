import { type FileHandle, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { LogFileEntry } from "@intentic/sandbox-contract";
import { forkedExec } from "@intentic/base/git";
import { MARKER_FILE } from "../system/boot/boot-marker.js";
import { RESTART_INTENT_FILE, RESTARTS_FILE } from "../system/boot/restart-record.js";
import { resolveWithin } from "../workspace/files/workspace-files-paths.js";

// Daemon-owned debug logs under historyRoot/logs: terminal captures (terminals/), intentic CLI runs (intentic-runs/),
// daemon.log, and resource-metrics.jsonl. Kept under historyRoot, outside the agent's /work mount.

// Prune policy:
// - truncate a file over its cap to its newest whole lines (safe under append-only writers); the logs the diagnostics
//   tools read keep what the cut dropped as one older segment beside them (`daemon.log.1`)
// - never cut a file that is one JSON document (a CPU profile, a fatal-error report): cutting corrupts it, so it is kept
//   whole, and only past WHOLE_MAX_BYTES removed
// - leave the restart record's files alone (KEPT)
// - drop files idle past MAX_AGE_MS
// - keep only the newest files of each group: a directory that churns (terminals/ gains hundreds of pane captures an
//   hour) is counted on its own, so it never pushes out a CPU profile or a service log the boot just named
const MAX_FILE_BYTES = 5_000_000;
const TAIL_BYTES = 1_000_000;
const MAX_AGE_MS = 30 * 24 * 3_600_000;
const MAX_FILES = 100;
const WHOLE_MAX_BYTES = 200_000_000;

// Files at the top of the logs root counted apart from the rest, by first path segment.
const GROUP_CAPS = new Map([
    ["terminals", 200],
    ["raw-output", 100],
    ["output-cache", 100],
]);

// Logs whose cut keeps an older segment: what the diagnostics tools read, so a cut never swings their reach from five
// days down to one. Before 2026-10-11 the cut dropped four fifths of daemon.log, and an investigation found the night
// it needed gone. Copy-and-truncate rather than rename, since pino's destination keeps writing to the file it opened.
const ROTATED = new Set(["daemon.log", "perf.jsonl", "client.jsonl"]);

// The restart record's own files (system/boot/): the previous run's exit marker, the intent a restart's asker left, and
// the boot log the `restarts` tool reads, which its writer bounds itself. Read at boot and by `ic`, never cut or evicted,
// however long the sandbox sat stopped.
const KEPT = new Set([MARKER_FILE, RESTART_INTENT_FILE, RESTARTS_FILE]);

// Extensions of files that are one JSON document rather than lines.
const WHOLE_FILE = /\.(?:cpuprofile|heapprofile|heapsnapshot|json)$/;

// resource-metrics.jsonl only (exact name, not extension): default caps would hold under a day of samples.
const FILE_CAPS: Readonly<Record<string, { readonly maxBytes: number; readonly tailBytes: number }>> = {
    "resource-metrics.jsonl": { maxBytes: 40_000_000, tailBytes: 30_000_000 },
};

const relativeName = (root: string, path: string): string => relative(root, path).split(sep).join("/");

const capFor = (root: string, path: string): { readonly maxBytes: number; readonly tailBytes: number } =>
    FILE_CAPS[relativeName(root, path)] ?? { maxBytes: MAX_FILE_BYTES, tailBytes: TAIL_BYTES };

/** The older segment a rotated log keeps beside itself; readers go on into it once the live file is exhausted. */
export const rotatedSegment = (path: string): string => `${path}.1`;

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

// `chunk` from `cut` on, moved forward past the first line break unless `chunk[cut - 1]` is one, so a JSONL tail never
// opens on half a line. A cut with no line break after it is one line's own tail and is kept whole.
export const lineAligned = (chunk: Buffer, cut: number): Buffer => {
    if (cut === 0) {
        return chunk;
    }
    const newline = chunk.indexOf(0x0a, cut - 1);
    return newline === -1 ? chunk.subarray(cut) : chunk.subarray(newline + 1);
};

// The newest `bytes` of an open file `size` bytes long, starting on a whole line, read from where they begin: what is
// before them never enters memory, however large the file has grown.
const alignedTail = async (handle: FileHandle, size: number, bytes: number): Promise<Buffer> => {
    const length = Math.min(bytes, size);
    // One byte before the cut rides along, so lineAligned can tell a cut that already fell on a line boundary.
    const lead = length < size ? 1 : 0;
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length + lead), 0, length + lead, size - length - lead);
    return lineAligned(buffer.subarray(0, bytesRead), lead);
};

// Newest `bytes` of a log file, starting on a whole line; undefined for a missing file or a name that escapes root (404).
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
        return { sizeBytes: size, text: (await alignedTail(handle, size, bytes)).toString("utf8") };
    } finally {
        await handle.close();
    }
};

interface PrunedFile {
    readonly path: string;
    readonly size: number;
    readonly mtimeMs: number;
}

// The count a file is held to: its directory's own when that directory churns, the shared one otherwise.
const groupOf = (root: string, path: string): string => {
    const name = relativeName(root, path);
    const first = name.split("/")[0] ?? "";
    return name.includes("/") && GROUP_CAPS.has(first) ? first : "";
};

// Files past their group's count, from a newest-first list.
const pastCount = (root: string, newestFirst: readonly PrunedFile[]): PrunedFile[] => {
    const counted = new Map<string, number>();
    return newestFirst.filter((file) => {
        const group = groupOf(root, file.path);
        const seen = (counted.get(group) ?? 0) + 1;
        counted.set(group, seen);
        return seen > (GROUP_CAPS.get(group) ?? MAX_FILES);
    });
};

// Cuts a line log to its newest whole lines. Only what is kept is read: a log storm between two passes can grow a file
// far past its cap, and reading it whole would put all of it in the daemon's heap. A rotated log's dropped head (its
// newest part, up to a cap's worth) goes to its older segment first, so a crash between the two writes duplicates lines
// rather than losing them. Read-then-rewrite can drop an append racing the rewrite; acceptable for debug logs at these
// caps.
const cutToTail = async (root: string, path: string): Promise<void> => {
    const cap = capFor(root, path);
    const handle = await open(path, "r");
    let tail: Buffer;
    let segment: Buffer | undefined;
    try {
        const size = (await handle.stat()).size;
        tail = await alignedTail(handle, size, cap.tailBytes);
        if (ROTATED.has(relativeName(root, path))) {
            segment = await alignedTail(handle, size - tail.length, cap.maxBytes - cap.tailBytes);
        }
    } finally {
        await handle.close();
    }
    if (segment !== undefined) {
        await writeFile(rotatedSegment(path), segment);
    }
    await writeFile(path, tail);
};

export const pruneLogFiles = async (root: string): Promise<void> => {
    const files: PrunedFile[] = [];
    for (const path of (await walkFiles(root)).filter((candidate) => !KEPT.has(relativeName(root, candidate)))) {
        try {
            const info = await stat(path);
            files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
        } catch {
            // Already gone.
        }
    }
    const now = Date.now();
    const live = files.filter((file) => now - file.mtimeMs <= MAX_AGE_MS).toSorted((a, b) => b.mtimeMs - a.mtimeMs);
    const counted = new Set(pastCount(root, live));
    const whole = live.filter((file) => WHOLE_FILE.test(file.path));
    const evicted = [
        ...files.filter((file) => now - file.mtimeMs > MAX_AGE_MS),
        ...counted,
        ...whole.filter((file) => !counted.has(file) && file.size > WHOLE_MAX_BYTES),
    ];
    await Promise.all(evicted.map((file) => rm(file.path, { force: true })));
    await Promise.all(
        live
            .filter((file) => !counted.has(file) && !WHOLE_FILE.test(file.path) && file.size > capFor(root, file.path).maxBytes)
            .map((file) => cutToTail(root, file.path)),
    );
};

// Global tmux hooks pipe every pane through pane-log-clean, which owns the file and renders the screen instead of raw
// escapes. Session name is sanitized; paired with pane id for a unique file name.
const pipeHook = (dir: string): string =>
    `pipe-pane -o "mkdir -p ${dir}; exec pane-log-clean ${dir}/#{s|[^a-zA-Z0-9_.-]|_|:session_name}-#{pane_id}.log #{pane_width} #{pane_height}"`;

// Matches INTENTIC_TERMINAL_LOGS_DIR (bootstrap/daemon-env.ts); bin/tmux-run composes `$dir/$session-$pane.log` from it for the output
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
        await forkedExec("tmux", args).catch(() => undefined);
    }
};
