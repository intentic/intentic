// What moves a checkout's HEAD, for the `git.branch-switch` class (policy/command-classes.ts). `switch` exists only to move
// HEAD, so every form of it counts. `checkout` is two commands wearing one name: with `-- <path>` or a bare `.` it
// restores files and moves nothing, and those are the common ones, so they are cut out. `symbolic-ref HEAD refs/…` is
// the plumbing spelling of the same move; reading it (no target) moves nothing.
//
// git's own options may stand between `git` and the verb (`git -C /work checkout x`, `git -c k=v switch x`), and they are
// read through, or naming a directory would be a way around the class.

const GLOBALS = String.raw`(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+|--no-pager|--no-optional-locks|-P))*`;

export const GIT_BRANCH_SWITCH: readonly RegExp[] = [
    new RegExp(String.raw`\bgit${GLOBALS}\s+switch\b`),
    new RegExp(String.raw`\bgit${GLOBALS}\s+checkout\b(?![^|;&]*\s--\s)(?![^|;&]*\s\.(?:\s|$))`),
    new RegExp(String.raw`\bgit${GLOBALS}\s+symbolic-ref\b[^|;&]*\sHEAD\s+refs\/`),
];
