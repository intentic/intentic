import { type Automation, type AutomationRun, AutomationRunSchema, AutomationSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

// The sandbox-owned automations manifest (<workspace>/.intentic/automations.json): the user's automations plus
// their daemon-recorded run history. The scheduler polls it; the /automations routes edit it. Mirrors the
// capabilities store. No secrets live here, so it is NOT on the file-route denylist.

// Kept per automation — enough for the UI's run history without the file growing forever.
const RUNS_KEPT = 20;

const AutomationRecordSchema = AutomationSchema.extend({ runs: z.array(AutomationRunSchema) });
export type AutomationRecord = z.infer<typeof AutomationRecordSchema>;

export interface AutomationsStore {
    readonly list: () => Promise<AutomationRecord[]>;
    readonly get: (id: string) => Promise<AutomationRecord | undefined>;
    // Upsert by id (re-adding the same id edits its config); an edit keeps the existing run history.
    readonly upsert: (automation: Automation) => Promise<void>;
    // True when an automation of that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
    // Prepend a run (newest first), capped at RUNS_KEPT. A run for a just-removed automation is dropped.
    readonly recordRun: (id: string, run: AutomationRun) => Promise<void>;
}

// A JSON file store, used in production at <workspace>/.intentic/automations.json.
export const fileAutomationsStore = (path: string): AutomationsStore => {
    const file = jsonFile<AutomationRecord[]>(path, {
        parse: (raw) => z.array(AutomationRecordSchema).safeParse(raw).data,
        fallback: () => [],
    });
    return {
        list: file.read,
        get: async (id) => (await file.read()).find((automation) => automation.id === id),
        upsert: async (automation) => {
            await file.update((automations) => {
                const existing = automations.find((record) => record.id === automation.id);
                return [...automations.filter((record) => record.id !== automation.id), { ...automation, runs: existing?.runs ?? [] }];
            });
        },
        remove: async (id) => {
            let removed = false;
            await file.update((automations) => {
                const next = automations.filter((automation) => automation.id !== id);
                removed = next.length !== automations.length;
                // Unchanged by reference when nothing matched, so removing an absent id writes nothing.
                return removed ? next : automations;
            });
            return removed;
        },
        recordRun: async (id, run) => {
            await file.update((automations) =>
                automations.some((automation) => automation.id === id)
                    ? automations.map((automation) =>
                          automation.id === id ? { ...automation, runs: [run, ...automation.runs].slice(0, RUNS_KEPT) } : automation,
                      )
                    : // A run for a just-removed automation is dropped — and writes nothing.
                      automations,
            );
        },
    };
};
