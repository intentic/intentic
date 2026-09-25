// Types for allow.mjs: the site pragma and commit trailer that excuse a check's finding.
export function pragmaReason(text: string, check: string): string | undefined;
export function allowedAt(lines: readonly string[], line: number, check: string, legacy?: RegExp): boolean;
export interface AllowTrailer {
    readonly check: string;
    readonly reason: string;
}
export function allowTrailers(text: string): AllowTrailer[];
