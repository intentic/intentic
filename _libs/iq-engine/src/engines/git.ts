import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FileEntry, RankedGroup, RankedHit } from "../types.js";
import { isIqDenied } from "../workspace/floor.js";

const exec = promisify(execFile);

const DEFAULT_SINCE = "7d";

// "2d" | "12h" | "1w" | "3m" → milliseconds.
const parseSince = (since: string): number => {
    const match = /^(\d+)([hdwm])$/.exec(since);
    if (match === null) {
        throw new Error(`iq: --since expects e.g. 12h, 2d, 1w, 3m — got: ${since}`);
    }
    const n = Number(match[1]);
    return n * { h: 3_600_000, d: 86_400_000, w: 604_800_000, m: 2_592_000_000 }[match[2] as "h" | "d" | "w" | "m"];
};

const agoText = (ms: number): string => {
    if (ms < 60_000) {
        return "just now";
    }
    if (ms < 3_600_000) {
        return `${Math.round(ms / 60_000)}m ago`;
    }
    if (ms < 86_400_000) {
        return `${Math.round(ms / 3_600_000)}h ago`;
    }
    return `${Math.round(ms / 86_400_000)}d ago`;
};

const reposOf = (entries: readonly FileEntry[]): string[] => [...new Set(entries.map((entry) => entry.repo).filter((repo) => repo !== undefined))];

const git = async (root: string, repo: string, args: string[]): Promise<string> => {
    const { stdout } = await exec("git", ["-C", join(root, repo), ...args], { maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
    return stdout;
};

const toWorkspacePath = (repo: string, repoRel: string): string => (repo === "" ? repoRel : `${repo}/${repoRel}`);

export interface RecentOptions {
    readonly since?: string;
    readonly author?: string;
    readonly pattern?: string;
}

interface FileActivity {
    latestMs: number;
    commits: number;
    adds: number;
    dels: number;
    uncommitted: boolean;
}

// `iq recent` — per-file change summary inside the window: committed activity from git log --numstat, plus
// uncommitted files by mtime. Paths outside the sweep (floor, scope) never surface.
export const recentFiles = async (root: string, entries: readonly FileEntry[], options: RecentOptions): Promise<RankedGroup[]> => {
    const windowMs = parseSince(options.since ?? DEFAULT_SINCE);
    const now = Date.now();
    const allowed = new Set(entries.map((entry) => entry.path));
    const activity = new Map<string, FileActivity>();

    for (const repo of reposOf(entries)) {
        const args = ["log", `--since=${Math.floor((now - windowMs) / 1000)}`, "--numstat", "--format=commit:%ct"];
        if (options.author !== undefined) {
            args.push(`--author=${options.author}`);
        }
        let commitMs = 0;
        for (const line of (await git(root, repo, args)).split("\n")) {
            if (line.startsWith("commit:")) {
                commitMs = Number(line.slice(7)) * 1000;
                continue;
            }
            const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
            if (match === null) {
                continue;
            }
            const path = toWorkspacePath(repo, match[3]!);
            if (!allowed.has(path) || isIqDenied(path)) {
                continue;
            }
            const entry = activity.get(path) ?? { latestMs: 0, commits: 0, adds: 0, dels: 0, uncommitted: false };
            entry.commits++;
            entry.adds += match[1] === "-" ? 0 : Number(match[1]);
            entry.dels += match[2] === "-" ? 0 : Number(match[2]);
            entry.latestMs = Math.max(entry.latestMs, commitMs);
            activity.set(path, entry);
        }
    }
    for (const entry of entries) {
        if (now - entry.mtimeMs <= windowMs && !activity.has(entry.path)) {
            activity.set(entry.path, { latestMs: entry.mtimeMs, commits: 0, adds: 0, dels: 0, uncommitted: true });
        }
    }

    const pattern = options.pattern !== undefined && options.pattern !== "" ? options.pattern.toLowerCase() : undefined;
    return [...activity.entries()]
        .filter(([path]) => pattern === undefined || path.toLowerCase().includes(pattern))
        .toSorted((a, b) => b[1].latestMs - a[1].latestMs || (a[0] < b[0] ? -1 : 1))
        .map(([path, info], rank) => {
            const summary = info.uncommitted
                ? `${agoText(now - info.latestMs)}   uncommitted`
                : `${agoText(now - info.latestMs)}   +${info.adds} -${info.dels}   (${info.commits} commit${info.commits === 1 ? "" : "s"})`;
            return { path, score: 1 / (rank + 1), hits: [{ path, line: 1, text: summary, tags: [], score: 1 / (rank + 1) }] };
        });
};

export interface LogOptions {
    readonly regex?: boolean;
    readonly since?: string;
    readonly author?: string;
    readonly path?: string;
}

// `iq log "<pattern>"` — pickaxe across repos: commits whose diffs add/remove the pattern. Commit metadata only,
// never patch bodies (a denied file's content can't leak through here).
export const logSearch = async (root: string, entries: readonly FileEntry[], pattern: string, options: LogOptions): Promise<RankedGroup[]> => {
    const groups: RankedGroup[] = [];
    for (const repo of reposOf(entries)) {
        const args = ["log", options.regex === true ? `-G${pattern}` : `-S${pattern}`, "--format=%h%x09%as%x09%an%x09%s"];
        if (options.since !== undefined) {
            args.push(`--since=${Math.floor((Date.now() - parseSince(options.since)) / 1000)}`);
        }
        if (options.author !== undefined) {
            args.push(`--author=${options.author}`);
        }
        if (options.path !== undefined) {
            const inRepo = options.path.startsWith(`${repo}/`) ? options.path.slice(repo.length + 1) : options.path;
            args.push("--", inRepo);
        }
        const hits: RankedHit[] = (await git(root, repo, args))
            .split("\n")
            .filter((line) => line !== "")
            .map((line, i) => ({ path: repo, line: i + 1, text: line.replaceAll("\t", "  "), tags: [], score: 1 }));
        if (hits.length > 0) {
            groups.push({ path: repo, score: 1 / (groups.length + 1), hits });
        }
    }
    return groups;
};

// `iq who path:line[-line]` — blame metadata for an anchor: commit, author, date, summary per distinct commit,
// plus the anchored source lines.
export const whoAnchor = async (
    root: string,
    entries: readonly FileEntry[],
    anchor: { path: string; line: number; endLine?: number },
): Promise<RankedGroup[]> => {
    const entry = entries.find((candidate) => candidate.path === anchor.path);
    if (entry?.repo === undefined) {
        throw new Error(`iq who: ${anchor.path} is not inside a git repo the sweep admits`);
    }
    const repoRel = anchor.path.slice(entry.repo.length + 1);
    const to = anchor.endLine ?? anchor.line;
    const stdout = await git(root, entry.repo, ["blame", "-L", `${anchor.line},${to}`, "--line-porcelain", "--", repoRel]);
    if (stdout === "") {
        return [];
    }
    const commits = new Map<string, { author: string; date: string; summary: string; lines: string[] }>();
    let current: { hash: string; author?: string; date?: string; summary?: string } | undefined;
    for (const line of stdout.split("\n")) {
        if (/^[0-9a-f]{40} /.test(line)) {
            current = { hash: line.slice(0, 7) };
            continue;
        }
        if (current === undefined) {
            continue;
        }
        if (line.startsWith("author ")) {
            current.author = line.slice(7);
        } else if (line.startsWith("author-time ")) {
            current.date = new Date(Number(line.slice(12)) * 1000).toISOString().slice(0, 10);
        } else if (line.startsWith("summary ")) {
            current.summary = line.slice(8);
        } else if (line.startsWith("\t")) {
            const existing = commits.get(current.hash) ?? {
                author: current.author ?? "?",
                date: current.date ?? "?",
                summary: current.summary ?? "",
                lines: [],
            };
            existing.lines.push(line.slice(1));
            commits.set(current.hash, existing);
        }
    }
    const hits = [...commits.entries()].flatMap(([hash, info], i) => [
        { path: anchor.path, line: i * 2 + 1, text: `${hash}  ${info.date}  ${info.author}  ${info.summary}`, tags: [], score: 1 },
        { path: anchor.path, line: i * 2 + 2, text: `line: ${info.lines.join(" ⏎ ")}`, tags: [], score: 1 },
    ]);
    return [{ path: anchor.path, score: 1, hits }];
};
