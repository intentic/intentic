// Types for cleaners.mjs, the cleaner registry every runtime's output filter shares.

// CSI, OSC and two-byte escapes; global, so reset `lastIndex` before reusing it with `test`.
export const ANSI: RegExp;

// The final frame of a line a spinner redrew with `\r`.
export const collapseCr: (line: string) => string;

// Weight of lines joined with newlines, without building the string.
export const bodyBytes: (lines: readonly string[]) => number;

// Every cleaner id a spec can name: the command cleaners, then the generic stages.
export const CLEANERS: readonly string[];

// One stage's attribution: bytes it removed from what reached it (negative when it added, like the footer).
export interface Stage {
    readonly id: string;
    readonly saved: number;
}

// One known secret value and what it masks to.
export interface SecretValue {
    readonly target: string;
    readonly replacement: string;
}

// Every encoding a value can surface in (raw, JSON-escaped, percent-encoded).
export const surfaceForms: (value: string) => string[];

// The sandbox's stored secret values, longest first; empty anywhere those stores do not exist.
export const secretValues: (env?: Record<string, string | undefined>) => SecretValue[];

// Masks known values and credential-shaped assignments in a whole body.
export const redactText: (text: string, values?: readonly SecretValue[]) => string;

// The enabled set from an INTENTIC_OUTPUT_CLEANERS spec: an allow-list, `-id` exclusions, or empty for all.
export const parseCleaners: (spec: string | undefined) => Set<string>;

export interface CleanOptions {
    readonly command: string;
    readonly exitCode: string;
    readonly enabled: ReadonlySet<string>;
    readonly values?: readonly SecretValue[];
}

// The gated line pipeline: command cleaners and the cap on success, dedup and a generous tail on failure.
export const cleanLines: (lines: readonly string[], options: CleanOptions) => { lines: string[]; stages: Stage[] };

// Which command cleaners claimed this command, for the savings report's gaps.
export const matchedCleaners: (command: string, enabled: ReadonlySet<string>) => string[];

// The prefix every repeat-collapse marker starts with.
export const CACHE_MARKER: string;

// The session a pane log belongs to: its name minus the trailing `-<pane>.log`.
export const sessionKeyFromLog: (logPath: string | undefined) => string | undefined;

export interface CacheStore {
    readonly lookup: (key: string) => string | undefined;
    readonly record: (key: string, value: string) => void;
}

// The per-session repeat detector, kept at <logsDir>/output-cache/<sessionKey>.json.
export const openCacheStore: (logsDir: string, sessionKey: string) => CacheStore;

// Collapses a body identical to an earlier one this session to a marker naming where it can be read back.
export const collapseCached: (
    body: string,
    command: string,
    store: CacheStore,
    retain?: () => string | undefined,
) => { body: string; cached: boolean };
