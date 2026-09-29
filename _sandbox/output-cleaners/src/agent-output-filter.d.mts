// Types for agent-output-filter.mjs: one Bash command's output, trimmed for the model and accounted for.
import type { CacheStore, SecretValue, Stage } from "./cleaners.mjs";

// The last pipeline's statuses when an earlier stage failed while the exit code still reads 0.
export const maskedFailure: (exitCode: string, pipeline: string) => string | undefined;

export interface FilterOptions {
    readonly command?: string;
    readonly exitCode?: string;
    readonly durationS?: string;
    // Keeps the unfiltered text and answers the path it can be read back from; called only when a footer names it.
    readonly retain?: (text: string) => string | undefined;
    readonly enabled?: ReadonlySet<string>;
    readonly cacheStore?: CacheStore | undefined;
    readonly values?: readonly SecretValue[];
    readonly pipeline?: string;
}

// The pure pipeline: what the model is handed, and each stage's share of the bytes it removed.
export const filterOutput: (raw: string, options: FilterOptions) => { out: string; stages: Stage[] };

export interface FilterRunOptions {
    readonly command?: string;
    readonly exitCode?: string;
    readonly durationS?: string;
    readonly pipeline?: string;
    readonly enabled?: ReadonlySet<string>;
    // Share of commands left untrimmed as the measurement's control, 0 to 1.
    readonly holdout?: number;
    // Where the pass keeps raw-output/, output-cache/ and filter-stats.jsonl; undefined keeps nothing.
    readonly logsDir?: string | undefined;
    // This run's raw-output file name, unique per command.
    readonly runName?: string | undefined;
    // Scopes the repeat cache to one session.
    readonly sessionKey?: string | undefined;
    readonly values?: readonly SecretValue[];
    // Extra fields for the ledger row (a project, a session); the pass's own fields win on a clash.
    readonly tags?: Readonly<Record<string, string>>;
    readonly random?: () => number;
    readonly now?: () => number;
}

// One command's whole pass; never throws, and falls back to the raw text (redacted) on any failure.
export const filterRun: (raw: string, options?: FilterRunOptions) => { out: string; heldOut: boolean; stages: Stage[] };
