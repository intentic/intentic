import type { CodeAnalysis } from "./codeAnalysis";

export interface CodeAnalysisRequest {
    readonly id: number;
    readonly text: string;
    readonly lang: string | undefined;
}

export type CodeAnalysisResponse =
    { readonly id: number; readonly analysis: CodeAnalysis | undefined } | { readonly id: number; readonly error: string };
