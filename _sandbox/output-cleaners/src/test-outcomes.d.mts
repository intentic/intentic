// Types for test-outcomes.mjs: the sandbox's record of test runs, and the baselines read from it.
import type { ParsedTest, TestCounts } from "./test-runs.mjs";

export interface RecordedTest extends ParsedTest {
    // The test's id across runs (test-digest.mjs testId).
    readonly id: string;
}

// One run as the filter hands it to the record.
export interface RunToRecord {
    readonly repo: string;
    readonly sha: string;
    // "clean", or a short hash of the tree's changes against HEAD.
    readonly tree: string;
    readonly fork?: string | undefined;
    readonly mainRef?: string | undefined;
    // A clean tree at a commit on the main line: its failures are main's.
    readonly baseline: boolean;
    readonly command: string;
    readonly by?: string | undefined;
    readonly runners: readonly string[];
    // A pipeline stage may have dropped lines of the output, or no summary was printed.
    readonly partial: boolean;
    readonly counts: TestCounts;
    readonly tests: readonly RecordedTest[];
}

// A run read back.
export interface RecordedRun {
    readonly at: number;
    readonly repo: string;
    readonly sha: string;
    readonly command: string;
    readonly by: string | undefined;
    readonly counts: TestCounts;
    readonly failed: readonly { readonly id: string; readonly name: string; readonly line: string | undefined }[];
    // Passing tests' short hashes, space-separated: ask passedIn.
    readonly passed: string;
    readonly baseline: boolean;
}

// What one repository's newest baselined main commit is known to fail on.
export interface MainBaseline {
    readonly repo: string;
    readonly sha: string;
    // The newest run there, in milliseconds.
    readonly at: number;
    readonly runs: readonly { readonly command: string; readonly at: number; readonly by: string | undefined; readonly counts: TestCounts }[];
    readonly failed: readonly { readonly test: string; readonly line: string | undefined; readonly at: number }[];
}

export const OUTCOMES_DIR: string;
export const passedIn: (run: RecordedRun, id: string) => boolean;
// Bounds the record is pruned to after each write: files, bytes and age in milliseconds (1000, 32 MiB, 21 days).
export interface RecordBounds {
    readonly files: number;
    readonly bytes: number;
    readonly ms: number;
}

export const recordRun: (dir: string, run: RunToRecord, now?: number, keep?: RecordBounds) => string | undefined;
export const baselinesAt: (dir: string, sha: string) => RecordedRun[];
export const baselineCommits: (dir: string) => string[];
export const mainBaselines: (dir: string) => MainBaseline[];
