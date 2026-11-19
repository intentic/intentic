// Types for test-digest.mjs: the digest a test run's output ends with, and the run recorded on the way.

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
}

// "" when the command ran no tests, or failed none.
export const testDigest: (lines: readonly string[], options: DigestOptions) => string;
