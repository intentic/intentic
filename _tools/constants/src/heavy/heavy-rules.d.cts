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
}

export const QUEUE_SKIPPED_EXIT_CODE: 75;
export const MATCH_LIMIT: number;
export const SHIPPED_HEAVY_COMMANDS: HeavyCommandSettings & { readonly rules: readonly HeavyCommandRule[] };
export const EARLIER_SHIPPED_RULES: readonly HeavyCommandRule[];
export function mergeHeavyRules(overrides?: HeavyCommandOverrides): HeavyCommands;
export function overridesOf(full: Partial<HeavyCommandSettings> & { readonly rules?: readonly HeavyCommandRule[] | undefined }): HeavyCommandOverrides;
export function matchInvocation(invocation: string, config: HeavyCommands, report?: (detail: string) => void): HeavyMatch | undefined;
export function queueArgs(match: HeavyMatch, config: HeavyCommandSettings): string[];
export function holdWarnSeconds(maxHold: number): number | undefined;
export function ruleById(config: HeavyCommands, id: string): HeavyCommandRule | undefined;
