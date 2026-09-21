// Types for vocabulary.mjs, the retired-word table the checkout gate reads.
export interface RetiredWord {
    readonly id: string;
    readonly pattern: RegExp;
    readonly became: string;
    readonly since: string;
}
export interface RetiredFinding {
    readonly id: string;
    readonly became: string;
    readonly line: number;
    readonly text: string;
}
export const RETIRED: readonly RetiredWord[];
export function retiredIn(text: string): RetiredFinding[];
