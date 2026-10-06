import { forkedExec } from "@intentic/base/git";

// Whether git ignores `path` (absolute, or relative to `cwd`) in the checkout at `cwd`. `--` ends the options, so a
// path that starts with `-` is asked about as a path and never read as a flag. Every failed ask reads as not ignored:
// exit 1 is git's own "not ignored", and outside a repository or without git there is no ignore rule to honour; both
// callers (rules/edit-bytes.ts, agent/providers/project-installs.ts) take "not ignored" as the stricter answer. Above
// the subsystems rather than inside git/, as git-identity.ts is: git/ already imports rules/, so a helper there would
// close a cycle.
export const gitIgnores = (cwd: string, path: string): Promise<boolean> =>
    forkedExec("git", ["-C", cwd, "check-ignore", "-q", "--", path]).then(
        () => true,
        () => false,
    );
