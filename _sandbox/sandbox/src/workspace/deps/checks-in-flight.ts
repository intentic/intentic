import { IGNORED_DIRS } from "@intentic/workspace-ignore";

// Which projects the daemon is running a check for right now, so the review can tell the build's writes from the
// owner's. A check runs the project's own build (verify-deps.ts), which empties an output dir the repo may track and
// rewrites it file by file; a scan landing in that window reads tracked files that are simply not there yet. Nothing
// else can correct it either: those dirs are exactly what the watcher prunes, so no path batch says they came back.

// Workspace-relative project dirs, "" being the root project. Counted, not a set: the same dir can be under a second
// check before the first releases, and one release must not clear the other's window.
const running = new Map<string, number>();

/** Opens `dir`'s check window; the returned call closes it, and must run however the check ends. */
export const markCheckRunning = (dir: string): (() => void) => {
    running.set(dir, (running.get(dir) ?? 0) + 1);
    return () => {
        const left = (running.get(dir) ?? 1) - 1;
        if (left > 0) {
            running.set(dir, left);
        } else {
            running.delete(dir);
        }
    };
};

/** Whether a check is running inside `repo`; "root" is the workspace root, whose project dir is "". */
export const checkRunningIn = (repo: string): boolean =>
    repo === "root" ? running.has("") : [...running.keys()].some((dir) => dir === repo || dir.startsWith(`${repo}/`));

/** Whether a repo-relative path sits under a dir a build rewrites wholesale (`dist/`, `.next/`, …), tracked or not. */
export const isBuildOutputPath = (path: string): boolean => path.split("/").some((segment) => IGNORED_DIRS.has(segment));
