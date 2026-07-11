import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Automation, type AutomationRun, AutomationRunSchema, AutomationSchema } from "@intentic/sandbox-contract";
import { z } from "zod";

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
    const read = async (): Promise<AutomationRecord[]> => {
        try {
            const parsed = z.array(AutomationRecordSchema).safeParse(JSON.parse(await readFile(path, "utf8")));
            return parsed.success ? parsed.data : [];
        } catch {
            return [];
        }
    };
    const write = async (automations: AutomationRecord[]): Promise<void> => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(automations, undefined, 2)}\n`);
    };
    return {
        list: read,
        get: async (id) => (await read()).find((automation) => automation.id === id),
        upsert: async (automation) => {
            const automations = await read();
            const existing = automations.find((record) => record.id === automation.id);
            await write([...automations.filter((record) => record.id !== automation.id), { ...automation, runs: existing?.runs ?? [] }]);
        },
        remove: async (id) => {
            const automations = await read();
            const next = automations.filter((automation) => automation.id !== id);
            if (next.length === automations.length) {
                return false;
            }
            await write(next);
            return true;
        },
        recordRun: async (id, run) => {
            const automations = await read();
            const record = automations.find((automation) => automation.id === id);
            if (record === undefined) {
                return;
            }
            record.runs = [run, ...record.runs].slice(0, RUNS_KEPT);
            await write(automations);
        },
    };
};
