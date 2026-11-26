import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { scannerPruneGlobs } from "@intentic/workspace-ignore";
import { DENIED_GLOBS, isStateDenied } from "./floor.js";
import { globToRegExp } from "./glob.js";

// The walk both searches share: which files rg is pointed at, which of what it finds the caller may have, and the rg
// child itself.

// What both searches are asked to look through.
export interface WalkScope {
    readonly root: string;
    // Into node_modules, build output and everything a .gitignore names; the floor still holds.
    readonly ignored?: boolean | undefined;
    // Root-relative subtrees (or files) to look in; undefined is the whole root, empty is nothing at all.
    readonly paths?: readonly string[] | undefined;
    // The files-to-include box, as globs over root-relative paths (search-globs.ts): any one must match (none given
    // admits every file), none of these.
    readonly globs?: readonly string[] | undefined;
    readonly notGlobs?: readonly string[] | undefined;
    // More of the walk pruned, as rg globs (`!**/node_modules`): a probe's walk, kept short (probes.ts).
    readonly prune?: readonly string[] | undefined;
    readonly rgPath?: string | undefined;
    // The caller letting go: the rg child is killed, so a superseded search stops spending the machine.
    readonly signal?: AbortSignal | undefined;
}

// Ignore-file sources beyond the workspace tree's own, switched off so the two cannot disagree (text-search.ts's head).
const WALK_ARGS = ["--no-config", "--hidden", "--no-ignore-global", "--no-ignore-exclude", "--no-ignore-dot", "--no-require-git"];

// The walk's own arguments: those ignore sources off, and the pruning. Pruning only: the walk skips what the post-filter
// would drop anyway. rg anchors globs at its working directory, the root, whatever paths it is given.
export const walkArgs = (scope: WalkScope): string[] => [
    ...WALK_ARGS,
    ...(scope.ignored === true ? ["--no-ignore"] : []),
    ...[...scannerPruneGlobs(scope.ignored === true), ...DENIED_GLOBS, ...(scope.prune ?? [])].flatMap((glob) => ["-g", glob]),
];

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

export const normalized = (path: string): string => {
    let end = path.length;
    while (path.charAt(end - 1) === "/") {
        end -= 1;
    }
    return path.slice(path.startsWith("./") ? 2 : 0, end);
};

// Where rg is pointed: the subtrees themselves when that is exact, else the root with parents off. Narrowed paths that
// do not exist are dropped, since rg exits 2 on one, which would read as a failed search.
export const targetsOf = async (options: WalkScope, prefixes: readonly string[] | undefined): Promise<{ args: string[]; paths: string[] }> => {
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

// Which found files the caller may have: the floor first, then the scope it asked for.
export const admitterOf = (options: WalkScope, prefixes: readonly string[] | undefined): ((path: string) => boolean) => {
    const globs = options.globs?.map(globToRegExp);
    const notGlobs = options.notGlobs?.map(globToRegExp) ?? [];
    const inPrefix = (path: string): boolean => prefixes === undefined || prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    const included = (path: string): boolean => globs === undefined || globs.length === 0 || globs.some((glob) => glob.test(path));
    return (path) => !isStateDenied(path) && inPrefix(path) && included(path) && !notGlobs.some((glob) => glob.test(path));
};

export interface RgRun {
    // Stopped by `onLine` answering false, not by rg finishing.
    readonly stopped: boolean;
    // rg's own: 0 found, 1 found nothing, 2 something went wrong (the pattern, or one file it could not read).
    readonly code: number;
    readonly stderr: string;
}

// One rg child, its stdout read a line at a time until `onLine` answers false, when the child is killed.
export const runRg = (
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
            reject(error.code === "ENOENT" ? new Error("ripgrep (rg) not found on PATH, install ripgrep or set RG_PATH") : error);
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
