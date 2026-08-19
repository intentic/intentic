import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* WHAT THE OWNER HAS ALREADY SAID NO TO (<workspace>/.intentic/config/capability-dismissals.json).
 *
 * Recommendations are derived on every read, so without this a declined one comes straight back on the next page
 * load and the Recommended slice becomes a nag strip — the surface people learn to stop looking at, which costs
 * far more than the one card they didn't want.
 *
 * KEYED BY THE EVIDENCE, NOT BY THE CARD. "I don't want GitLab" is not what the click means; "I don't want it for
 * THIS" is. So a row records the evidence the card was declined against, and a workspace that changes underneath
 * it — a new repo, a remote moved to a different host — asks again, because the question is genuinely a new one.
 * One row per card is all that is ever kept: the evidence it was declined against is either the current one (in
 * which case it silences it) or stale (in which case it is answering a question nobody is asking any more).
 */

export interface DismissedRecommendation {
    readonly card: string;
    readonly evidence: string;
}

const DismissedSchema = z.array(z.object({ card: z.string(), evidence: z.string() }));

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
            await file.update((entries) => [...entries.filter((existing) => existing.card !== entry.card), entry]);
        },
    };
};
