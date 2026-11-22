// Types for test-digest.mjs: the digest a test run's output ends with, and the run recorded on the way.
import type { RunLoad } from "./test-outcomes.mjs";

export interface DigestOptions {
    readonly command: string;
    // The directory the command started in.
    readonly cwd: string;
    // Where runs are recorded; absent, none is, and no baseline is read.
    readonly dir?: string | undefined;
    // Who ran it (the conversation).
    readonly by?: string | undefined;
    readonly narrowed?: boolean;
    readonly now?: number;
    // Whether the `base` command is installed; read from PATH when absent.
    readonly hasBase?: boolean;
    // The machine's load as the run ended, recorded with it and compared with the baseline's; read when absent.
    readonly load?: RunLoad | undefined;
}

// "" when the command ran no tests, or failed none. A failure is labelled new only where a baseline run passed it;
// one no baseline run included is labelled "not run at main@…".
export const testDigest: (lines: readonly string[], options: DigestOptions) => string;
