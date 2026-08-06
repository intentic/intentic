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

/* How many times in a row this automation has now failed — the number the spin-loop guard reads.
 *
 * Runs are newest-first, so this counts from the front and stops at the first run that was not an `error`. Only
 * `error` breaks the streak's silence: a `completed` run obviously resets it, and so does a `skipped` one,
 * because a guard saying no is the automation working exactly as configured. `interrupted` is the interesting
 * case and it also resets — the daemon died under that fire, which says nothing about whether the automation
 * itself is broken, and counting it would let a couple of container restarts quarantine a healthy job.
 *
 * Bounded by RUNS_KEPT, which is the honest ceiling: past 20 the history has already rolled and a longer
 * streak is not knowable from the record. Any sane limit is far below that. */
export const consecutiveFailures = (runs: readonly AutomationRun[]): number => {
    const firstSurvivor = runs.findIndex((run) => run.outcome !== "error");
    return firstSurvivor === -1 ? runs.length : firstSurvivor;
};

export interface AutomationsStore {
    readonly list: () => Promise<AutomationRecord[]>;
    readonly get: (id: string) => Promise<AutomationRecord | undefined>;
    // Upsert by id (re-adding the same id edits its config); an edit keeps the existing run history.
    readonly upsert: (automation: Automation) => Promise<void>;
    // Atomically change one switch on the current record. True when the id existed.
    readonly setEnabled: (id: string, enabled: boolean) => Promise<boolean>;
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
        setEnabled: async (id, enabled) => {
            let found = false;
            await file.update((automations) => {
                const existing = automations.find((automation) => automation.id === id);
                if (existing === undefined) {
                    return automations;
                }
                found = true;
                return existing.enabled === enabled
                    ? automations
                    : automations.map((automation) => (automation.id === id ? { ...automation, enabled } : automation));
            });
            return found;
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
