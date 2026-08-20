/* Git's one-letter status vocabulary and the colour each letter is read in, the data behind <ChangeStatusMark>.
 *
 * `!` for a conflict, git's own porcelain letter being `U`, but `U` next to `M`/`A`/`D` reads as one more
 * flavour of change, and a conflict is a stop sign. Danger-coloured for the same reason.
 *
 * Not exported from the barrel: the mark is the only thing that should be rendering these, and a caller reaching
 * for the table directly is a caller about to hand-roll a seventh copy of the span. */

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "type-changed" | "conflicted";

export const STATUS_LETTER: Record<ChangeStatus, string> = {
    added: `A`,
    modified: `M`,
    deleted: `D`,
    renamed: `R`,
    "type-changed": `T`,
    conflicted: `!`,
};

export const STATUS_CLASS: Record<ChangeStatus, string> = {
    added: `text-success`,
    modified: `text-warning`,
    deleted: `text-danger`,
    renamed: `text-muted`,
    "type-changed": `text-muted`,
    conflicted: `text-danger`,
};
