// Types for heavy-rules.cjs, the one heavy-command table the daemon, the program hook and the scripts read.
export type OnDeadline = "run" | "skip";

export interface HeavyCommandRule {
    readonly id: string;
    // JS regex source, case-insensitive, matched against `<program> <args…>` of the program that runs.
    readonly pattern: string;
    readonly pool?: string | undefined;
    readonly limit?: number | undefined;
    readonly maxHoldSeconds?: number | undefined;
    readonly exempt?: boolean | undefined;
    readonly onDeadline?: OnDeadline | undefined;
    // A regex the program's working directory must match too, for what its arguments cannot name.
    readonly cwd?: string | undefined;
    // The memory gate's price by name (memory-room.mjs SIZE_BYTES) instead of its class's; an unknown name is the class.
    readonly size?: string | undefined;
    // Judged even under a program already holding a slot, while every held pool is one no `nests` rule names.
    readonly nests?: boolean | undefined;
}

// An owner's change to the table: a shipped rule's id changes the fields it names, or removes it (`disabled`); any other
// id, with a pattern, is the owner's own rule.
export interface HeavyCommandRuleEdit {
    readonly id: string;
    readonly pattern?: string | undefined;
    readonly pool?: string | undefined;
    readonly limit?: number | undefined;
    readonly maxHoldSeconds?: number | undefined;
    readonly exempt?: boolean | undefined;
    readonly onDeadline?: OnDeadline | undefined;
    // A regex the program's working directory must match too, for what its arguments cannot name.
    readonly cwd?: string | undefined;
    // The memory gate's price by name (memory-room.mjs SIZE_BYTES) instead of its class's; an unknown name is the class.
    readonly size?: string | undefined;
    // Judged even under a program already holding a slot, while every held pool is one no `nests` rule names.
    readonly nests?: boolean | undefined;
    readonly disabled?: boolean | undefined;
}

export interface HeavyCommandSettings {
    readonly limit: number;
    readonly defaultPool: string;
    readonly waitSeconds: number;
    readonly memoryGateSeconds: number;
    readonly maxHoldSeconds: number;
    readonly onDeadline: OnDeadline;
}

export interface HeavyCommandOverrides {
    readonly limit?: number | undefined;
    readonly defaultPool?: string | undefined;
    readonly waitSeconds?: number | undefined;
    readonly memoryGateSeconds?: number | undefined;
    readonly maxHoldSeconds?: number | undefined;
    readonly onDeadline?: OnDeadline | undefined;
    readonly queue?: boolean | undefined;
    readonly ruleEdits?: readonly HeavyCommandRuleEdit[] | undefined;
}

export interface HeavyCommands extends HeavyCommandSettings {
    // False stops queueing; heavy programs keep their class either way.
    readonly queue: boolean;
    readonly rules: readonly HeavyCommandRule[];
}

export interface HeavyMatch {
    readonly id: string;
    readonly pool: string;
    readonly limit: number;
    readonly maxHold: number;
    readonly onDeadline: OnDeadline;
    readonly size?: string;
}

// Where a program runs, for the rules that look past its arguments.
export interface MatchWhere {
    readonly cwd?: string | undefined;
    // The pools programs above it already hold slots of (heldPoolsOf).
    readonly heldPools?: readonly string[] | undefined;
}

export const QUEUE_SKIPPED_EXIT_CODE: 75;
export const MATCH_LIMIT: number;
export const SHIPPED_HEAVY_COMMANDS: HeavyCommandSettings & { readonly rules: readonly HeavyCommandRule[] };
export const EARLIER_SHIPPED_RULES: readonly HeavyCommandRule[];
export function mergeHeavyRules(overrides?: HeavyCommandOverrides): HeavyCommands;
export function overridesOf(full: Partial<HeavyCommandSettings> & { readonly rules?: readonly HeavyCommandRule[] | undefined }): HeavyCommandOverrides;
export function matchInvocation(invocation: string, config: HeavyCommands, report?: (detail: string) => void, where?: MatchWhere): HeavyMatch | undefined;
export function queueArgs(match: HeavyMatch, config: HeavyCommandSettings): string[];
// Whether a test invocation names the files it runs, for the memory gate's smaller price.
export function targetedRun(invocation: string): boolean;
// queue-run's `--size <name>`: the rule's own size, else `targeted` for a targeted test run under a test rule, else nothing.
export function sizeArgs(match: HeavyMatch, invocation: string): string[];
export function holdWarnSeconds(maxHold: number): number | undefined;
export function ruleById(config: HeavyCommands, id: string): HeavyCommandRule | undefined;
// The pools the programs above one already hold slots of, from INTENTIC_HEAVY_HELD and INTENTIC_QUEUE_SLOT.
export function heldPoolsOf(env: Readonly<Record<string, string | undefined>>, config: HeavyCommands): string[];
