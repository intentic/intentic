import { join } from "node:path";
import { type Automation, type AutomationRun, AutomationRunSchema, AutomationSchema, type ModelPin } from "@intentic/sandbox-contract";
import { z } from "zod";
import { drop, fold, isJsonObject, type JsonObject, nested } from "../store/evolution/conversions.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument, openEntries } from "../store/open-document.js";
import { defineStep } from "../store/evolution/state-steps.js";
import { stateRelPath } from "../state-paths.js";

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

// Until 2026-09-07 an automation named its model with three optional fields; now it names a ladder of whole pins. One
// that named a model gets a one-rung ladder of it. One that named none inherited a sandbox-wide default no conversion
// can see, and stays in the manifest, skipped and reported, for its owner to pick a model.
const modelLadder = fold("folds agent, harness and model into a one-rung models ladder", {
    from: ["agent", "harness", "model"],
    into: "models",
    applies: (entry) => typeof entry["model"] === "string" && !Object.hasOwn(entry, "models"),
    convert: ({ agent, harness, model }): ModelPin[] => [
        { provider: typeof agent === "string" ? agent : "claude", model: String(model), ...(harness === "native" || harness === "claude-code" ? { harness } : {}) },
    ],
});

export const automationsDocument = defineDocument({
    path: stateRelPath(".intentic/config/automations.json"),
    schema: AutomationSchema,
    granularity: "entries",
    // `issues.ingestKey` was withdrawn on 2026-09-06 (control tokens replaced it); a credential with no reader left in a
    // tracked file, so it goes.
    history: [modelLadder, ...nested("issues", [drop("ingestKey")])],
    // The relocation step below moves a webhook token into the door store.
    movedByStep: ["trigger.token"],
});
export const automationRunsDocument = defineDocument({ path: stateRelPath(".intentic/records/automation-runs.json"), schema: RunLedgerSchema });
type RunLedger = z.infer<typeof RunLedgerSchema>;

const parsedJson = (text: string | undefined): unknown => {
    try {
        return text === undefined ? undefined : JSON.parse(text);
    } catch {
        // allow(silent-catch): an unreadable file has nothing to move; its own store reports it
        return undefined;
    }
};

const canonical = (value: unknown): string => `${JSON.stringify(value, undefined, 2)}\n`;

// What an automation entry carries that lives elsewhere now: embedded run history, an event trigger's webhook token.
const carriesElsewhere = (entry: unknown): entry is JsonObject & { id: string } =>
    isJsonObject(entry) && typeof entry["id"] === "string" && (Array.isArray(entry["runs"]) || (isJsonObject(entry["trigger"]) && typeof entry["trigger"]["token"] === "string"));

// Two things the manifest once held move out of it: run history (split into the runs ledger on 2026-08-11) and an event
// trigger's webhook token (into the door store on 2026-09-06, since a credential has no place in a tracked file). A
// moved token keeps working: the fire route checks the door store for exactly the value callers were given. Neither
// ever overwrites what its new home holds, and only runs this version can read are moved, since one bad run would sink
// the whole ledger.
export const automationsRelocationStep = defineStep({
    id: "automations-runs-and-webhook-tokens",
    describe: "moves embedded run history into the runs ledger and webhook tokens into the door store",
    plan: async ({ roots, read }) => {
        const manifestPath = join(roots.workspace, automationsDocument.path);
        const manifest = parsedJson(await read(manifestPath));
        if (!Array.isArray(manifest) || !manifest.some(carriesElsewhere)) {
            return undefined;
        }
        const ledgerPath = join(roots.workspace, automationRunsDocument.path);
        const doorsPath = join(roots.workspace, stateRelPath(".intentic/secrets/doors.json"));
        const ledgerRaw = parsedJson(await read(ledgerPath));
        const doorsRaw = parsedJson(await read(doorsPath));
        const ledger: Record<string, unknown> = isJsonObject(ledgerRaw) ? { ...ledgerRaw } : {};
        const doors: JsonObject = isJsonObject(doorsRaw) ? { ...doorsRaw } : {};
        const automationDoors: Record<string, unknown> = isJsonObject(doors["automation"]) ? { ...doors["automation"] } : {};
        const moved = { runs: 0, tokens: 0 };
        const stripped = manifest.map((entry) => {
            if (!carriesElsewhere(entry)) {
                return entry;
            }
            const { runs, ...withoutRuns } = entry;
            if (Array.isArray(runs)) {
                const readable = runs.filter((run) => AutomationRunSchema.safeParse(run).success);
                const standing = Array.isArray(ledger[entry.id]) ? (ledger[entry.id] as unknown[]) : [];
                ledger[entry.id] = [...standing, ...readable].slice(0, RUNS_KEPT);
                moved.runs += 1;
            }
            const trigger = withoutRuns["trigger"];
            if (!isJsonObject(trigger) || typeof trigger["token"] !== "string") {
                return withoutRuns;
            }
            const { token, ...withoutToken } = trigger;
            automationDoors[entry.id] ??= token;
            moved.tokens += 1;
            return { ...withoutRuns, trigger: withoutToken };
        });
        const writes = new Map<string, string>([[manifestPath, canonical(stripped)]]);
        const changes: string[] = [];
        if (moved.runs > 0) {
            writes.set(ledgerPath, canonical(ledger));
            changes.push(`moves the run history of ${moved.runs} automation(s) into the runs ledger`);
        }
        if (moved.tokens > 0) {
            writes.set(doorsPath, canonical({ ...doors, automation: automationDoors }));
            changes.push(`moves ${moved.tokens} webhook token(s) into the door store, where their URLs keep working`);
        }
        return { changes, writes };
    },
});

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
    // One entry at a time: a single automation this build cannot read is skipped and kept, never the whole manifest.
    const file = openEntries(automationsDocument, path);
    // Unreadable runs fall back to no history rather than reading as an absent manifest, which would silently stop
    // every automation.
    // Rebuild unreadable run history only from the next recorded run.
    const ledger = openDocument(automationRunsDocument, runsPath, { fallback: (): RunLedger => ({}) });
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
