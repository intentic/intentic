import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

// Declined-recommendation store (<workspace>/.intentic/config/capability-dismissals.json). Keyed by the evidence a entry
// was declined against, not the entry: a workspace change (new repo, moved remote) asks again. One row per entry.

export interface DismissedRecommendation {
    readonly entry: string;
    readonly evidence: string;
}

const DismissedSchema = z.array(z.object({ entry: z.string(), evidence: z.string() }));

export interface DismissalsStore {
    readonly list: () => Promise<DismissedRecommendation[]>;
    readonly dismiss: (entry: DismissedRecommendation) => Promise<void>;
}

export const fileDismissalsStore = (path: string): DismissalsStore => {
    const file = jsonFile<DismissedRecommendation[]>(path, {
        parse: (raw) => DismissedSchema.safeParse(raw).data,
        fallback: () => [],
    });
    return {
        list: file.read,
        dismiss: async (entry) => {
            await file.update((entries) => [...entries.filter((existing) => existing.entry !== entry.entry), entry]);
        },
    };
};
