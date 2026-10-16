// What the command readers share: one shell word, the answer a reader gives about it, and the stand-in a secret
// reference becomes before anything is read.

// Why a part of the command cannot be read, as a clause that finishes "…because "; every reader answers either its
// finding or one of these.
export interface Unreadable {
    readonly why: string;
}

// One shell word with its quoting taken off; `dynamic` when a `$` expansion inside double quotes fills part of it, whose
// value exists only when the command runs. `assignment` when the word as written opens with an unquoted `NAME=`, the
// only spelling a shell takes as setting a variable (`"A=x"` is a program named `A=x`).
export interface Word {
    readonly text: string;
    readonly dynamic: boolean;
    readonly assignment?: boolean;
}

// The hosts one stage would reach (none for a stage that connects nowhere), or why they cannot be read.
export type Reach = { readonly hosts: readonly string[] } | Unreadable;

// Reads one program's arguments, the words after its name.
export type ProgramReader = (args: readonly Word[]) => Reach;

// A reference stands in as a character no host, flag or operator contains, so a secret spelled into a host or a program
// name fails every test instead of passing as whatever its value happens to be.
export const STAND_IN = "\u0001";
