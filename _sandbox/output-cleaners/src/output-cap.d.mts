export const MAX: number;
export const FAIL_TAIL: number;
export const LOG_MAX_BYTES: number;
export const READ_MAX_BYTES: number;
export const READ_COMMAND: RegExp;
export const byteBudget: (command: string) => number;
export const capOutput: (
    lines: readonly string[],
    command: string,
    limits?: { readonly chars?: number; readonly lines?: number; readonly head?: number; readonly tail?: number },
) => readonly string[];
export const priorityCap: (lines: readonly string[], maxLines: number, maxBytes: number, fallback: readonly string[], head?: number) => readonly string[];
