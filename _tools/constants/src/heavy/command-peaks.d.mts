// Types for command-peaks.mjs: which command a queued run is, for the price the memory gate learns from its peaks.

/** What a command is priced at once a peak was measured, and why: the wait line says it (`pricedWords`). */
export interface LearnedPrice {
    // What the gate holds for it: its peak with the margin, capped at the sandbox's limit (memory-room.mjs learnedCostBytes).
    readonly bytes: number;
    // The most it took over its recent runs, and how many runs that is.
    readonly peakBytes: number;
    readonly runs: number;
    // The words it is named by (`commandWords`).
    readonly command: string;
}

/** The record a queued command's peak is kept under, and the words it is named by. */
export interface CommandSignature {
    readonly key: string;
    readonly command: string;
}

export interface Checkout {
    // The repository's name, from its common git directory: the same for every worktree of it.
    readonly repo: string;
    readonly root: string;
    // The working directory, relative to `root`; "" at the root.
    readonly dir: string;
}

export function lineWords(line: string): string[];
export function commandWords(argv: readonly string[], root?: string): string | undefined;
export function checkoutOf(cwd: string): Checkout | undefined;
export function commandSignature(options: { readonly rule: string; readonly command: readonly string[]; readonly cwd?: string }): CommandSignature | undefined;
export function queuedCommand(argv: readonly string[]): string[] | undefined;
export function startTicksOf(stat: string): number | undefined;
export function queuedSignature(
    pid: number,
    rule: string,
    options?: { readonly proc?: string; readonly cwd?: string },
): (CommandSignature & { readonly start: number }) | undefined;
export function namedSignature(
    pid: number,
    key: string | undefined,
    command: string | undefined,
    options?: { readonly proc?: string },
): (CommandSignature & { readonly start: number }) | undefined;
// The rule an agent's whole line is recorded and queued under once it grew heavy outside the queue.
export const LEARNED_RULE: "learned";
export const LEARNED_MIN_BYTES: number;
export function lineSignature(line: string, cwd: string | undefined): CommandSignature | undefined;
export const PEAK_MARGIN: number;
export function learnedCostBytes(configuredBytes: number, peakBytes: number | undefined, limitBytes: number | undefined): number;
export function peakWords(priced: LearnedPrice): string;
export function pricedWords(priced: LearnedPrice | undefined): string;
