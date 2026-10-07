import { REFERENCE_DIR } from "@intentic/constants";
import { type GitChanges, type GitLog, STARTER_REPO } from "@intentic/sandbox-contract";

// WHAT COUNTS AS WORK, for the warning that this sandbox's work has nowhere to be pushed. A brand-new hosted sandbox is
// not empty: the daemon keeps its own dotted state in /work, and the first boot seeds the starter site (`site`, one
// commit, no remote; scaffold/starter-site.ts). Counting files, as this once did, told a person who had not typed a word
// yet that their work had nowhere to go, and on a phone that sentence headed the Menu as its badge (2026-10-06).
//
// So work is what somebody made: anything at the top of the workspace the sandbox did not put there itself, or the
// starter site once it has moved past its seed, a commit on top of it (an agent's landed work is one) or anything
// uncommitted in it.

// The sandbox's own furniture: its dotted state, and the reference shelf (the same two the daemon's emptiness check skips).
const furniture = (name: string): boolean => name.startsWith(`.`) || name === REFERENCE_DIR;

// Whether the starter site still stands as it was seeded: `seed`, `moved`, or `unread` while either read is out.
export type StarterState = `seed` | `moved` | `unread`;

// The top-level entries somebody made, for whether only the starter site is left to judge.
export const madeEntries = (names: readonly string[]): readonly string[] => names.filter((name) => !furniture(name));

// Only the starter site and furniture at the top: the one case the starter's own history decides.
export const onlyStarter = (names: readonly string[] | undefined): boolean => {
    const made = names === undefined ? [] : madeEntries(names);
    return made.length === 1 && made[0] === STARTER_REPO;
};

// Read off its log (asked for one commit, so `hasMore` means a second) and the workspace's uncommitted changes. A log
// that could not be read is not the seed, which always has exactly one commit: a `site` folder that is not that repo
// is somebody's.
export const starterStateOf = (log: { readonly data?: GitLog; readonly failed: boolean }, changes: GitChanges | undefined): StarterState => {
    if (log.failed) {
        return `moved`;
    }
    if (log.data === undefined || changes === undefined) {
        return `unread`;
    }
    const pending = changes.repos.find((repo) => repo.repo === STARTER_REPO);
    const touched =
        pending !== undefined &&
        pending.staged.length +
            pending.unstaged.length +
            pending.conflicted.length +
            (pending.truncated?.staged ?? 0) +
            (pending.truncated?.unstaged ?? 0) >
            0;
    return touched || log.data.hasMore || log.data.commits.length !== 1 ? `moved` : `seed`;
};

// Whether the workspace holds work: undefined names (a tree not read yet) say nothing, and neither does a starter site
// whose history has not been read.
export const holdsWork = (names: readonly string[] | undefined, starter: StarterState): boolean => {
    if (names === undefined) {
        return false;
    }
    const made = madeEntries(names);
    return made.some((name) => name !== STARTER_REPO) || (made.includes(STARTER_REPO) && starter === `moved`);
};
