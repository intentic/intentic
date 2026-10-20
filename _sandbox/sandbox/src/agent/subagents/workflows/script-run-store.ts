import { join } from "node:path";
import { z } from "zod";
import { AgentHarnessSchema, AgentProviderSchema } from "@intentic/sandbox-contract/schemas/agent";
import type { Services } from "../../../composition.js";
import { defineDocument } from "../../../store/evolution/documents.js";
import { openDirectory } from "../../../store/open-document.js";

// A workflow run as it is written down (script-runs.ts runs it): one file per run under the history volume, written as it
// moves and read back by a restart, a resume and the status tool.

// The provider and model a call runs on when it names none: the run's own, as the tool was given them.
const DefaultsSchema = z.object({
    provider: AgentProviderSchema,
    model: z.string().min(1),
    harness: AgentHarnessSchema.optional(),
    effort: z.string().optional(),
});
export type ScriptDefaults = z.infer<typeof DefaultsSchema>;

const ScriptCallSchema = z.object({
    // What it asks, hashed, and which asking of it this was within the run.
    key: z.string(),
    occurrence: z.number().int().min(0),
    label: z.string(),
    phase: z.string().optional(),
    // The child doing it; absent for one handed back from the cache.
    child: z.string().optional(),
    state: z.enum(["running", "done", "failed"]),
    cached: z.boolean().optional(),
    value: z.json().optional(),
    error: z.string().optional(),
    repairs: z.number().int().min(0),
});
export type ScriptCall = z.infer<typeof ScriptCallSchema>;

const ScriptRunSchema = z.object({
    parent: z.string(),
    // The parent turn's working tree, where its children are cut from and land into.
    cwd: z.string(),
    name: z.string(),
    description: z.string().optional(),
    phases: z.array(z.object({ title: z.string(), detail: z.string().optional() })).optional(),
    source: z.string(),
    args: z.json(),
    defaults: DefaultsSchema.optional(),
    concurrency: z.number().int().min(1),
    resumedFrom: z.string().optional(),
    state: z.enum(["running", "done", "failed", "stopped"]),
    phase: z.string().optional(),
    log: z.array(z.string()),
    calls: z.array(ScriptCallSchema),
    result: z.json().optional(),
    error: z.string().optional(),
    startedAt: z.number(),
    endedAt: z.number().optional(),
    at: z.number(),
});
export type ScriptRun = z.infer<typeof ScriptRunSchema>;

export const scriptRunsDocument = defineDocument({
    root: "history",
    path: "script-runs/",
    // One file per workflow run a conversation started: its script, its calls and what each handed back, so a restart
    // picks it up where it was and a later run can resume from its finished calls. Part of the conversations' own
    // record, so it goes where they go.
    portability: "carry",
    directory: true,
    schema: ScriptRunSchema,
});

// A run in progress in this process: its record, its stop, what settles when it ends, and the workers it waits on.
export interface LiveRun {
    readonly id: string;
    readonly record: ScriptRun;
    readonly stop: AbortController;
    readonly ended: PromiseWithResolvers<void>;
}

// The run files, one per run, under the history volume.
export const runFiles = (services: Pick<Services, "config">): ReturnType<typeof openDirectory<typeof scriptRunsDocument>> =>
    openDirectory(scriptRunsDocument, join(services.config.historyRoot, scriptRunsDocument.path));

// Every write of one run in the order it was made; a failed one is said and the run goes on.
const WRITES = new Map<string, Promise<void>>();
export const keepRun = (services: Pick<Services, "config" | "logger">, live: LiveRun): void => {
    live.record.at = Date.now();
    const snapshot: ScriptRun = structuredClone(live.record);
    const before = WRITES.get(live.id) ?? Promise.resolve();
    const next = before.then(async () => {
        try {
            await runFiles(services).write(live.id, snapshot);
        } catch (error) {
            services.logger.warn({ err: error, run: live.id }, "workflow run: could not be written down, a restart forgets what it did since");
        }
    });
    WRITES.set(live.id, next);
};

// A finished call from an earlier run (or this one, before a restart), handed back for the same asking.
export type Cache = Map<string, ScriptCall>;
export const cacheOf = (calls: readonly ScriptCall[]): Cache => new Map(calls.filter((call) => call.state === "done").map((call) => [`${call.key}#${call.occurrence}`, call]));

// A run as its file holds it; undefined for none, and for one this build cannot read, which is said.
export const runOnFile = async (services: Pick<Services, "config" | "logger">, run: string): Promise<ScriptRun | undefined> => {
    // A run that just ended is read as its last write left it, not as the one before.
    await WRITES.get(run);
    try {
        return await runFiles(services).read(run);
    } catch (error) {
        services.logger.warn({ err: error, run }, "workflow run: its file could not be read");
        return undefined;
    }
};

