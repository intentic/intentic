/* Git's one-letter status vocabulary and the colour each letter is read in, the data behind <ChangeStatusMark>. The
 * vocabulary itself is the contract's (ChangeStatusSchema), the one every change list is parsed with. */
import type { ChangeStatus } from "@intentic/sandbox-contract";
import { toneInk } from "../../lib/tone.js";

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
    added: toneInk(`success`),
    modified: toneInk(`warning`),
    deleted: toneInk(`danger`),
    renamed: `text-muted`,
    "type-changed": `text-muted`,
    conflicted: toneInk(`danger`),
};
