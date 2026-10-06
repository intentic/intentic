/* Git's one-letter status vocabulary and the colour each letter is read in, the data behind <ChangeStatusMark>. The
 * vocabulary itself is the contract's (ChangeStatusSchema), the one every change list is parsed with. */
import type { ChangeStatus } from "@intentic/sandbox-contract";

export type { ChangeStatus };

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
