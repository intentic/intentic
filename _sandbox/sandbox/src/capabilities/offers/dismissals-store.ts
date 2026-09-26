import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openEntries } from "../../store/open-document.js";
import { stateRelPath } from "../../state-paths.js";

// Declined-recommendation store (<workspace>/.intentic/config/capability-dismissals.json). Keyed by the evidence a entry
// was declined against, not the entry: a workspace change (new repo, moved remote) asks again. One row per entry.

export interface DismissedRecommendation {
    readonly entry: string;
    readonly evidence: string;
}

const DismissedSchema = z.object({ entry: z.string(), evidence: z.string() });

export const dismissalsDocument = defineDocument({
    path: stateRelPath(".intentic/config/capability-dismissals.json"),
    schema: DismissedSchema,
    granularity: "entries",
});

export interface DismissalsStore {
    readonly list: () => Promise<DismissedRecommendation[]>;
    readonly dismiss: (entry: DismissedRecommendation) => Promise<void>;
}

export const fileDismissalsStore = (path: string): DismissalsStore => {
    const file = openEntries(dismissalsDocument, path, { idKeys: ["entry"] });
    return {
        list: file.read,
        dismiss: async (entry) => {
            await file.update((entries) => [...entries.filter((existing) => existing.entry !== entry.entry), entry]);
        },
    };
};
