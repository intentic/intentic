import type { RepoTarget, ScratchPath } from "@intentic/sandbox-contract/schemas/git/git";

// What a discard card asks about, resolved when the press is armed (ReviewPanel).
export interface DiscardTarget {
    // The whole heading, one message per scope ("Discard every uncommitted change in intentic?", "Discard 3 selected
    // files?"), so a translation words each question itself instead of wrapping an English phrase.
    readonly question: string;
    // Untracked paths are deleted, not reverted: git holds no copy of them, so this is the one part not recoverable
    // from git.
    readonly deletes: readonly string[];
    // Distinct tracked paths returning to their last committed state.
    readonly restores: number;
    // True wherever the daemon truncated: the discard covers the whole scope, but these counts and the deletion
    // list can only speak for the rows the panel was given, so this says when they're a floor, not the total.
    readonly partial: boolean;
    // Scratch folders the discard takes with it, named by size rather than by file: they are the one thing here that is
    // thousands of files, and no list of them is worth reading.
    readonly folders: readonly ScratchPath[];
    readonly groups: readonly RepoTarget[];
    // The confirm press's word when "Discard" would misname it: a folder of build files is deleted, not reverted.
    readonly verb?: string;
}
