import type { SecretValue } from "./cleaners.mjs";

export const ANSI: RegExp;
export const collapseCr: (line: string) => string;
export const invocation: (word: string) => RegExp;
export const bodyBytes: (lines: readonly string[]) => number;
export const IMPORTANT: RegExp;
export type Redactor = (text: string, values?: readonly SecretValue[]) => string;
