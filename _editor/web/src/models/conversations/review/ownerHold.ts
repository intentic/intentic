import type { GitChanges } from "@intentic/sandbox-contract/schemas/git/git";
import { t } from "@intentic/ui/i18n";
import { blockerLabel, type Blocker } from "./conflictResolution";

// What the owner's half of a refused land IS, read off their own Changes: the land report only says "workspace" (their
// uncommitted work stands in the way), and a card that said "your edits" over a file they had deleted sent them looking
// for an edit that did not exist (deft-lynx-0y1h, 2026-10-26). A deletion also has two answers the card can carry out
// itself, which an edit (theirs to judge) does not: keep it deleted, or put the file back.
export interface OwnerHold {
    // `deleted`: every held file is one the owner deleted. `edited`: anything else, a deletion among edits included.
    readonly kind: `deleted` | `edited`;
    readonly blockers: readonly Blocker[];
    // The one file's repo-qualified path, when there is exactly one.
    readonly only: string | undefined;
}

// The status the owner's tree gives a path, either side of the index; a path deleted on one side and edited on the
// other is not a deletion to keep.
const statusesOf = (changes: GitChanges, blocker: Blocker): readonly string[] => {
    const repo = changes.repos.find((entry) => entry.repo === blocker.repo);
    if (repo === undefined) {
        return [];
    }
    return [...repo.conflicted, ...repo.staged, ...repo.unstaged].filter((change) => change.path === blocker.path).map((change) => change.status);
};

const isDeletion = (changes: GitChanges, blocker: Blocker): boolean => {
    const statuses = statusesOf(changes, blocker);
    return statuses.length > 0 && statuses.every((status) => status === `deleted`);
};

// Undefined while either half is unread, or when the owner holds nothing: the card then keeps its general sentence.
export const ownerHoldOf = (blockers: readonly Blocker[], changes: GitChanges | undefined): OwnerHold | undefined => {
    if (blockers.length === 0 || changes === undefined) {
        return undefined;
    }
    const [first] = blockers;
    return {
        kind: blockers.every((blocker) => isDeletion(changes, blocker)) ? `deleted` : `edited`,
        blockers,
        only: blockers.length === 1 && first !== undefined ? blockerLabel(first) : undefined,
    };
};

// The last segment, for a card's one line; the whole path rides in its hover.
export const fileName = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);

// Per repo, since a commit or a discard is one repo's.
export const pathsByRepo = (blockers: readonly Blocker[]): ReadonlyMap<string, readonly string[]> => {
    const byRepo = new Map<string, string[]>();
    for (const blocker of blockers) {
        byRepo.set(blocker.repo, [...(byRepo.get(blocker.repo) ?? []), blocker.path]);
    }
    return byRepo;
};

// The hold in one sentence, naming the file when there is one: the board card and the review's conflict bar say it alike.
export const ownerHoldLine = (owner: OwnerHold): string => {
    const count = owner.blockers.length;
    const name = owner.only === undefined ? undefined : fileName(owner.only);
    if (owner.kind === `deleted`) {
        return name === undefined ? t(`agents.agentCard.youDeletedFiles`, { count }, count) : t(`agents.agentCard.youDeletedFile`, { name });
    }
    return name === undefined ? t(`agents.agentCard.yourChangesToFiles`, { count }, count) : t(`agents.agentCard.yourChangesToFile`, { name });
};
