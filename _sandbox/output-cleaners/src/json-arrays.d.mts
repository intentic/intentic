import type { SecretValue } from "./cleaners.mjs";
import type { Redactor } from "./cleaner-shapes.mjs";

export const compactJsonArrays: (lines: readonly string[], values: readonly SecretValue[], redactText: Redactor) => readonly string[];
