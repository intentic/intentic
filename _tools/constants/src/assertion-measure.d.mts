// Types for assertion-measure.mjs, so the daemon's agreement test (agent-tests.test.ts) can import it by path.
export interface AssertionMeasure {
    readonly exact: number;
    readonly loose: number;
    readonly chars: number;
    readonly tests: number;
}
export type Weakening = "downgrade" | "narrowing";
export const NARROWING: number;
export const TEST_FILE: RegExp;
export const EXACT: readonly string[];
export const LOOSE: readonly string[];
export const PY_EXACT: readonly string[];
export const PY_LOOSE: readonly string[];
export function measure(source: string): AssertionMeasure;
export function measurePython(source: string): AssertionMeasure;
export function measureFile(source: string, path: string): AssertionMeasure;
export function weakened(before: AssertionMeasure | undefined, after: AssertionMeasure): Weakening | undefined;
export function describeWeakening(path: string, shape: Weakening, before: AssertionMeasure, after: AssertionMeasure): string;
