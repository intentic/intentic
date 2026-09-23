export type SuiteKind = "unit" | "integration";
export const INTEGRATION_MARKERS: readonly string[];
export const SUITE_TIMEOUTS: Readonly<Record<SuiteKind, number>>;
export const SUITE_KINDS: readonly SuiteKind[];
export const INTEGRATION_NAME: RegExp;
export function suiteKindOf(file: string): SuiteKind;
