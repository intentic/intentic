// Types for test-runs.mjs: a test run's output read as tests, per runner.

export type TestOutcome = "pass" | "fail" | "ignored";

export interface ParsedTest {
    // The binary or package it ran in (Rust, Go), or the file it is in (JS runners), as the runner printed it.
    readonly suite?: string;
    readonly file?: string;
    readonly name: string;
    readonly outcome: TestOutcome;
    // For a failure: its first telling line (a panic's message and place, the error printed with it).
    readonly line?: string;
}

export interface TestCounts {
    readonly passed: number;
    readonly failed: number;
    readonly ignored: number;
}

export interface ParsedTestRun {
    readonly runners: readonly string[];
    readonly tests: readonly ParsedTest[];
    readonly counts: TestCounts;
    // Whether every runner's summary was in the output (a `| grep` or `| tail` can drop it).
    readonly summarized: boolean;
}

// Every runner's tests in the output (cargo test, nextest, bun test; vitest, jest, pytest, go test best-effort).
export const parseTestRun: (lines: readonly string[]) => ParsedTestRun | undefined;
