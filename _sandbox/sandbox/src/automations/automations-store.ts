import { type Automation, type AutomationRun, AutomationRunSchema, AutomationSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

// The sandbox-owned automations manifest and the run ledger beside it; the scheduler polls the manifest, the
// /automations routes edit it.
// Two files since they answer different readers: the manifest is tracked configuration a person edits, the ledger is a
// daemon-written record that fires never touch.
// Keyed by automation id: `upsert` and `remove` alone keep the ledger holding an entry only for an id the manifest
// still has.

// Kept per automation, enough for the UI's run history without the ledger growing forever.
const RUNS_KEPT = 20;

// The joined read model every caller sees: the automation with its runs read back from the ledger; the split is this
// store's own detail.
export type AutomationRecord = Automation & { runs: AutomationRun[] };

const RunLedgerSchema = z.record(z.string(), z.array(AutomationRunSchema));
type RunLedger = z.infer<typeof RunLedgerSchema>;

// Runs for an id the manifest no longer has are invisible by construction: the join walks the manifest, never the
// ledger's keys.
const withRuns = (automations: readonly Automation[], runs: RunLedger): AutomationRecord[] =>
    automations.map((automation) => ({ ...automation, runs: runs[automation.id] ?? [] }));

// How many times in a row this automation has failed, counting from the newest run until one isn't an `error`.
// `interrupted` also resets the streak (a daemon death says nothing about the automation); bounded by RUNS_KEPT, since
// history beyond it is unknowable.
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

// Two JSON file stores, used in production at <workspace>/.intentic/config/automations.json and its runs sibling.
export const fileAutomationsStore = (path: string, runsPath: string): AutomationsStore => {
    const file = jsonFile<Automation[]>(path, {
        parse: (raw) => z.array(AutomationSchema).safeParse(raw).data,
        fallback: () => [],
    });
    // Unreadable runs fall back to no history rather than reading as an absent manifest, which would silently stop
    // every automation.
    // Not on the unreadable-manifest notice either: nobody hand-edits a run history, and the next recorded run rebuilds
    // it.
    const ledger = jsonFile<RunLedger>(runsPath, {
        parse: (raw) => RunLedgerSchema.safeParse(raw).data,
        fallback: () => ({}),
    });
    return {
        list: async () => withRuns(await file.read(), await ledger.read()),
        get: async (id) => {
            const automation = (await file.read()).find((record) => record.id === id);
            return automation === undefined ? undefined : { ...automation, runs: (await ledger.read())[id] ?? [] };
        },
        upsert: async (automation) => {
            let existed = false;
            await file.update((automations) => {
                existed = automations.some((record) => record.id === automation.id);
                return [...automations.filter((record) => record.id !== automation.id), automation];
            });
            // A new automation starts with no history even if its id was used before; this only fires in the gap
            // `remove` can't close, a run recorded against an id mid-removal.
            // Unchanged by reference when there's nothing to clear, so an ordinary edit or first-time add writes
            // nothing here.
            if (!existed) {
                await ledger.update((runs) => {
                    if (runs[automation.id] === undefined) {
                        return runs;
                    }
                    const { [automation.id]: _stale, ...rest } = runs;
                    return rest;
                });
            }
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
            // The manifest goes first: a crash between the two writes leaves an orphan history nothing can see.
            // The other order would leave a live automation whose past had already been erased.
            if (removed) {
                await ledger.update((runs) => {
                    if (runs[id] === undefined) {
                        return runs;
                    }
                    const { [id]: _dropped, ...rest } = runs;
                    return rest;
                });
            }
            return removed;
        },
        recordRun: async (id, run) => {
            // A run for a just-removed automation is dropped, and writes nothing.
            // Checked against the manifest, since that's what decides an automation exists; the ledger can't answer it.
            if (!(await file.read()).some((automation) => automation.id === id)) {
                return;
            }
            await ledger.update((runs) => ({ ...runs, [id]: [run, ...(runs[id] ?? [])].slice(0, RUNS_KEPT) }));
        },
    };
};
