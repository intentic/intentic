import { type RuleFirings, RuleFiringsSchema } from "@intentic/sandbox-contract";
import { jsonFile } from "../store/json-file.js";

// One last-fired timestamp per rule id, so a rule that quietly stopped firing is visible. Stamped only when a rule did
// something, not merely matched: a match with nothing to do would make every row look busy. Kept in its own file, not
// on the settings object, since a firing is not an edit and would race the settings screen's optimistic writes.

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
        // Deleted rules' ids are left in place unpruned; nothing reads an id that no longer exists in settings.
        stamp: async (ruleId, at) => {
            await file.update((current) => ({ ...current, [ruleId]: at }));
        },
    };
};
