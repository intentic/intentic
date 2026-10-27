import { applyPresetItems, demoComplianceReport, demoPresetItems } from "../../fixture/data-protection/compliance";
import { demoComplianceDocument } from "../../fixture/data-protection/documents";
import type { Doors } from "../doors";

// The data protection page over a fresh sandbox: the documents are drafted from the report it draws, and the preset's
// apply changes what the next report and preview say (and the privacy shield's mode, for its first item).
export const complianceDoors = {
    report: () => demoComplianceReport(),
    preset: () => ({ items: demoPresetItems() }),
    document: ({ kind, language, format }) => demoComplianceDocument(kind, language, format),
    applyPreset: ({ items }) => applyPresetItems(items),
} satisfies Doors<`compliance`>;
