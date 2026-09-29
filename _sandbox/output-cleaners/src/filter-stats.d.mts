// Types for filter-stats.mjs, the one reading of the savings ledger (filter-stats.jsonl) every report shares.

// One ledger row. Every field is optional: an older row may predate one, and the reader never trusts a row's shape.
export interface StatRow {
    readonly ts?: number;
    readonly command?: string;
    readonly exit?: string;
    readonly durationS?: number;
    readonly rawBytes?: number;
    readonly emittedBytes?: number;
    readonly cleaners?: readonly string[];
    readonly matched?: readonly string[];
    readonly heldOut?: boolean;
    // Bytes each stage removed on this command, keyed by stage id (negative when it added, like the footer).
    readonly stageBytes?: Readonly<Record<string, number>>;
    // Tags a runtime filed the row under (the Claude Code plugin's project and session).
    readonly project?: string;
    readonly session?: string;
}

export interface SavingsSummary {
    readonly commands: number;
    readonly rawTokens: number;
    readonly emittedTokens: number;
    // Exact: each cleaned command's own raw against what it emitted.
    readonly savedPct: number;
    // Per-stage attribution, biggest first; sums to raw minus emitted.
    readonly perCleaner: { readonly id: string; readonly commands: number; readonly savedTokens: number }[];
    // The held-out control; `measuredSavedPct` only once it is large enough and the difference is significant.
    readonly holdout: { readonly cleaned: number; readonly heldOut: number; readonly measuredSavedPct?: number };
    // Commands no cleaner claimed, by the verb a handler would match on, weighed by what the model was handed.
    readonly gaps: { readonly command: string; readonly commands: number; readonly tokens: number }[];
}

export const summarizeStats: (rows: readonly StatRow[]) => SavingsSummary;

// The rows of a ledger file; blank and corrupt lines are skipped.
export const parseStatsFile: (text: string) => StatRow[];

// The verb a cleaner would match on (`git status`, `rg`), recovered from the line the agent wrote.
export const commandSignature: (command: string) => string;
