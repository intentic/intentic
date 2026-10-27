import type { GroupSamples } from "./context.ts";

export const complianceSamples: GroupSamples<`compliance`> = () => ({
    report: undefined,
    preset: undefined,
    document: { kind: `ropa`, language: `pl`, format: `docx` },
    applyPreset: { items: [`retention.transcriptDays`] },
});
