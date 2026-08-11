import { type Automation, type AutomationRun, AutomationRunSchema, AutomationSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* The sandbox-owned automations manifest (<workspace>/.intentic/automations.json), and the run ledger beside it
 * (<workspace>/.intentic/automation-runs.json). The scheduler polls the manifest; the /automations routes edit
 * it. Mirrors the capabilities store. No secrets live here, so neither is on the file-route denylist.
 *
 * TWO FILES, because they answer to different readers. The manifest is CONFIGURATION — a handful of entries a
 * person authors, and one of the few things under `.intentic` the root repo tracks, so an edit to it earns a
 * diff in the Changes review and a line in `git log`. The runs are a LEDGER, written by the daemon every time
 * an automation fires and never edited by anyone.
 *
 * Holding both in one file made the second overwrite the first's whole point: a scheduled automation firing
 * three times a day rewrote the tracked manifest three times a day, so run timestamps and conversation ids
 * were committed beside the prompt they belonged to and any real edit to the automation arrived buried in
 * them. Splitting is the whole fix — the tracked file now changes only when someone changes an automation, and
 * a fire touches nothing tracked. sandbox-contract's workspace-state.ts carries the same argument as the
 * general rule the ledgers there are already classified by.
 *
 * The ledger is keyed by automation id, which is what makes an edit keep its history for free: `upsert`
 * rewrites the config record and never touches the runs. The two files are separately atomic and separately
 * queued, so the invariant they hold between them — the ledger has an entry only for an id the manifest has —
 * is maintained by the two writes that can break it (`remove` drops the key, `upsert` of a NEW id clears any
 * stale one) rather than by a lock across both. */

// Kept per automation — enough for the UI's run history without the ledger growing forever.
const RUNS_KEPT = 20;

// The joined read model every caller sees: the stored automation with its runs read back from the ledger. The
// two files are an implementation detail of this store — nothing above it knows the history lives apart.
export type AutomationRecord = Automation & { runs: AutomationRun[] };

const RunLedgerSchema = z.record(z.string(), z.array(AutomationRunSchema));
type RunLedger = z.infer<typeof RunLedgerSchema>;

// Runs for an id the manifest no longer has are invisible by construction — the join is driven by the manifest,
// never by the ledger's keys, so an orphaned history can never surface as an automation.
const withRuns = (automations: readonly Automation[], runs: RunLedger): AutomationRecord[] =>
    automations.map((automation) => ({ ...automation, runs: runs[automation.id] ?? [] }));

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

// Two JSON file stores, used in production at <workspace>/.intentic/automations.json and its runs sibling.
export const fileAutomationsStore = (path: string, runsPath: string): AutomationsStore => {
    const file = jsonFile<Automation[]>(path, {
        parse: (raw) => z.array(AutomationSchema).safeParse(raw).data,
        fallback: () => [],
    });
    /* Unreadable runs fall back to "no history", which is the right loss to take: the manifest still lists every
     * automation and the scheduler still fires them, with empty rows where the history was. The alternative —
     * letting a damaged ledger read as an absent manifest — would silently stop every automation in the
     * sandbox. It is not on the unreadable-manifest notice either (see workspace-state.ts): nobody hand-edits
     * a run history, so there is nothing for an owner to repair, and the next recorded run rebuilds it. */
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
            /* A NEW automation starts with no history, even when its id was used before. Removing an automation
             * drops its runs below, so this only fires in the gap that write cannot close — a run recorded
             * against an id in the instant it was being removed — and it is what stops those few records
             * surfacing as the new automation's past. Unchanged by reference when there is nothing to clear,
             * so the ordinary edit and the ordinary first-time add both write nothing here. */
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
            // The manifest is what makes an automation exist, so it goes first: a crash between the two writes
            // leaves an orphan history nothing can see, where the other order would leave a live automation
            // whose past had already been erased.
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
            // A run for a just-removed automation is dropped — and writes nothing. Checked against the manifest
            // because that is what decides an automation exists; the ledger cannot answer it.
            if (!(await file.read()).some((automation) => automation.id === id)) {
                return;
            }
            await ledger.update((runs) => ({ ...runs, [id]: [run, ...(runs[id] ?? [])].slice(0, RUNS_KEPT) }));
        },
    };
};
