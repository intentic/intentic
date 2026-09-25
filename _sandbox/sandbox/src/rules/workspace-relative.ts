import { isAbsolute } from "node:path";

// A path outside the turn's cwd is left alone, not rewritten as `../` noise: it isn't a workspace path. One helper for
// every reader that matches a rule's workspace-relative globs, or the same glob would mean two things in two places.
export const workspaceRelative = (path: string, cwd: string | undefined): string => {
    if (cwd === undefined || !isAbsolute(path)) {
        return path;
    }
    const rooted = cwd.endsWith("/") ? cwd : `${cwd}/`;
    return path.startsWith(rooted) ? path.slice(rooted.length) : path;
};
