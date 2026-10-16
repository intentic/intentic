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

// An issuer's literal prefix and the regex source of the body it mints after it.
export interface CredentialIssuer {
    readonly prefix: string;
    readonly body: string;
}

// The terminal's copy of the contract's issuer table, and its prefixes alone; a parity test keeps the two equal.
export const CREDENTIAL_ISSUERS: readonly CredentialIssuer[];
export const CREDENTIAL_ISSUER_PREFIXES: readonly string[];

// A `{{secret:name}}` reference, capturing the name; not global. The contract's SECRET_REFERENCE is the same pattern.
export const SECRET_REFERENCE: RegExp;

// The reference a stored value masks to.
export const secretReference: (name: string) => string;

// The shortest stored value masked by value; shorter ones are not distinctive enough to blank.
export const SECRET_VALUE_MIN: number;

// One store a secret value lives in: which root it sits under, its path there, how it lays out its values, and what the
// daemon's registry records a value from it as.
export interface SecretStore {
    readonly root: "auth" | "desiredState";
    readonly path: string;
    readonly layout: "env" | "flat" | "vault";
    readonly source: "env" | "sandbox" | "generated" | "capability" | "copy" | "device";
}

// Every store, in the order a name two of them hold resolves.
export const SECRET_STORES: readonly SecretStore[];

// Every encoding a value can surface in (raw, JSON-escaped, percent-encoded).
export const surfaceForms: (value: string) => string[];

// The sandbox's stored secret values, longest first; empty anywhere those stores do not exist.
export const secretValues: (env?: Record<string, string | undefined>) => SecretValue[];
/** A store the daemon encrypts at rest, opened when a readable at-rest key fits; plain text passes through. */
export const openAtRest: (text: string, purpose: string, env?: Record<string, string | undefined>) => string | undefined;

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
