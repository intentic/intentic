// Types for filter-stats.mjs, the one reading of the savings ledger (filter-stats.jsonl) every report shares.

// One ledger row. Every field is optional: an older row may predate one, and the reader never trusts a row's shape.
export interface StatRow {
    readonly ts?: number;
    readonly command?: string;
    readonly exit?: string;
    readonly durationS?: number;
    readonly rawBytes?: number;
    readonly emittedBytes?: number;
    // Estimated tokens of the raw output and of what the model was handed (src/token-estimate.mjs); absent on rows from
    // before 2026-11-26, which the summary counts at four bytes a token.
    readonly rawTokens?: number;
    readonly emittedTokens?: number;
    readonly cleaners?: readonly string[];
    readonly matched?: readonly string[];
    readonly heldOut?: boolean;
    // Bytes each stage removed on this command, keyed by stage id (negative when it added, like the footer).
    readonly stageBytes?: Readonly<Record<string, number>>;
    // Per-conversation holdout fields: present when a conversation id is known.
    readonly conversationHash?: string;
    // The raw-output file name, so retrievals can be linked back.
    readonly runName?: string;
}

// One retrieval row (retrieve-stats.jsonl). Every field is optional for forward-compatibility.
export interface RetrievalRow {
    readonly ts?: number;
    readonly runName?: string;
    readonly conversationId?: string;
    readonly pattern?: string;
}

// Per-stage harm: of the commands a stage trimmed, how many the model came back for, by a retrieval of the run's raw
// file or by running the same command again within K; `followedUp` counts a command once even when it did both.
export interface HarmStage {
    readonly id: string;
    readonly trimmed: number;
    readonly retrieved: number;
    readonly reRun: number;
    readonly followedUp: number;
    readonly harmRate: number;
}
export interface HarmSummary {
    readonly K: number;
    readonly perStage: HarmStage[];
    // The held-out conversations' own re-run share: the baseline a stage's re-runs have to beat.
    readonly heldOutReRun?: { readonly commands: number; readonly reRunRate: number };
    readonly caveat?: string;
}

// Per-conversation arm comparison.
export interface ArmSummary {
    readonly cleaned: { readonly conversations: number; readonly medianCommands: number; readonly medianEmittedBytes: number };
    readonly heldOut: { readonly conversations: number; readonly medianCommands: number; readonly medianEmittedBytes: number };
    readonly emittedBytesDeltaPct?: number;
}

export interface SavingsSummary {
    readonly commands: number;
    readonly rawTokens: number;
    readonly emittedTokens: number;
    // Each cleaned command's own raw tokens against what it emitted.
    readonly savedPct: number;
    // Per-stage attribution, biggest first; a stage's bytes in tokens at its row's own rate, so about raw minus emitted.
    readonly perCleaner: { readonly id: string; readonly commands: number; readonly savedTokens: number }[];
    // The held-out control; `measuredSavedPct` only once it is large enough and the difference is significant.
    readonly holdout: { readonly cleaned: number; readonly heldOut: number; readonly measuredSavedPct?: number };
    // Commands no cleaner claimed, by the verb a handler would match on, weighed by what the model was handed.
    readonly gaps: { readonly command: string; readonly commands: number; readonly tokens: number }[];
    // Per-stage harm: the share of trimmed commands followed by a retrieval or re-run. Absent without per-conversation data.
    readonly harm?: HarmSummary;
    // Per-conversation arm comparison. Absent when fewer than 5 conversations per arm.
    readonly arms?: ArmSummary;
}

export const summarizeStats: (rows: readonly StatRow[], retrievals?: readonly RetrievalRow[]) => SavingsSummary;

// Per-stage harm, exposed for unit tests.
export const summarizeHarm: (rows: readonly StatRow[], retrievals?: readonly RetrievalRow[], K?: number) => HarmSummary | undefined;

// Per-conversation arm comparison, exposed for unit tests.
export const summarizeArms: (rows: readonly StatRow[]) => ArmSummary | undefined;

// The rows of a ledger file; blank and corrupt lines are skipped.
export const parseStatsFile: (text: string) => StatRow[];

// The verb a cleaner would match on (`git status`, `rg`), recovered from the line the agent wrote.
export const commandSignature: (command: string) => string;
