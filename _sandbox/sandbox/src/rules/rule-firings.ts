import { type RuleFirings, RuleFiringsSchema } from "@intentic/sandbox-contract";
import { jsonFile } from "../store/json-file.js";

/* WHEN EACH RULE LAST DID SOMETHING — one number per rule id, and the entire reason it exists is that a rule
 * nobody has seen fire is indistinguishable from a rule that is quietly broken.
 *
 * The failure this prevents is specific and it is the one every standing-rule system eventually produces: an
 * owner adds a hold on a repo, forgets, and three weeks later work is piling up on branches with no visible
 * cause. The settings list showing "last fired 3 weeks ago" beside that rule is the difference between a rule
 * they trust and one they would rather delete.
 *
 * DID SOMETHING, not "was considered". A rule that matched and then had nothing to do is not news, and
 * stamping it would make every row read as busy — which is the same as no signal at all.
 *
 * Its own file rather than a field on the settings object, because a firing is not an edit. Folding it in
 * would make every push a settings write, and would put a value that moves on its own inside the object the
 * settings screen patches optimistically — two writers, one of them a background job, racing over the owner's
 * configuration. */

export interface RuleFiringsStore {
    readonly get: () => Promise<RuleFirings>;
    readonly stamp: (ruleId: string, at: number) => Promise<void>;
}

export const fileRuleFiringsStore = (path: string): RuleFiringsStore => {
    const file = jsonFile<RuleFirings>(path, {
        parse: (raw) => RuleFiringsSchema.safeParse(raw).data,
        fallback: () => ({}),
    });
    return {
        get: file.read,
        // Ids of rules the owner has since deleted are left where they are: the file is a handful of numbers,
        // and pruning it would need the settings object as an argument — a store reaching for another store's
        // state to decide what to forget. A stale entry has no reader, because the list only asks about rules
        // that exist.
        stamp: async (ruleId, at) => {
            await file.update((current) => ({ ...current, [ruleId]: at }));
        },
    };
};
