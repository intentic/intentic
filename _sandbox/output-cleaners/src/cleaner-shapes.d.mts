import type { SecretValue } from "./cleaners.mjs";

export const ANSI: RegExp;
export const collapseCr: (line: string) => string;
export const invocation: (word: string) => RegExp;
export const bodyBytes: (lines: readonly string[]) => number;
export const IMPORTANT: RegExp;
export type Redactor = (text: string, values?: readonly SecretValue[]) => string;

// What of a multi-line value masks on its own: each line, and each entry's value where it reads as a dotenv.
export const multilineParts: (value: string) => string[];

// One word of a command line: as written (quotes kept) and as the shell reads it.
export interface ShellWord {
    readonly raw: string;
    readonly value: string;
}

// One top-level command: the operator that joined it to the one before ("" for the first), and its pipeline's stages.
export interface ShellCommand {
    readonly after: string;
    readonly stages: readonly (readonly ShellWord[])[];
}

// A command line split at `&&`, `||`, `;`, `&` and newlines; undefined for a heredoc, a subshell, a substitution, a
// compound command or an unclosed quote.
export const shellCommands: (line: string) => ShellCommand[] | undefined;
