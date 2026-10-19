import { join } from "node:path";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import type { ManagedProcesses, ManagedProcessesOptions, ProcessSpec } from "./managed-processes.js";

// No env: a panel's env is the daemon's own credentials, handed fresh at restore rather than kept on disk.
const PanelSchema = z.object({
    key: z.string(),
    // The port it last ran on, for the record; a restored panel is given a free one again.
    port: z.number().int().positive().optional(),
    spec: z.object({ command: z.string(), cwd: z.string(), portEnv: z.array(z.string()).optional() }),
});
type SavedPanel = z.infer<typeof PanelSchema>;

// Only user-started panels opt in (`durable`). Installs, checks and capability daemons have their own lifecycles.
export const panelRecordsDocument = defineDocument({ root: "history", path: "panels.json", schema: z.array(PanelSchema) });
const panelRecords = (historyRoot: string) =>
    openDocument(panelRecordsDocument, join(historyRoot, panelRecordsDocument.path), { fallback: () => [], mode: 0o600 });

const saveable = (key: string, spec: ProcessSpec, port?: number): SavedPanel => {
    const saved: SavedPanel = { key, spec: { command: spec.command, cwd: spec.cwd } };
    if (spec.portEnv !== undefined) {
        saved.spec.portEnv = [...spec.portEnv];
    }
    if (port !== undefined) {
        saved.port = port;
    }
    return saved;
};

/**
 * The manager with its user-started panels on disk: a durable start is written before its session is launched (so a
 * crash inside the launch still brings it back), a stop forgets it, and `restore` starts every saved one again.
 */
export const withSavedPanels = (options: ManagedProcessesOptions, processes: Omit<ManagedProcesses, "restore">): ManagedProcesses => {
    if (options.historyRoot === undefined) {
        return { ...processes, restore: async () => {} };
    }
    const records = panelRecords(options.historyRoot);
    const put = (panel: SavedPanel) => records.update((panels) => [...panels.filter((entry) => entry.key !== panel.key), panel]);
    return {
        ...processes,
        start: async (key, spec) => {
            if (spec.durable === true) {
                await put(saveable(key, spec));
            }
            await processes.start(key, spec);
            const port = processes.portOf(key);
            if (spec.durable === true && port !== undefined) {
                await put(saveable(key, spec, port));
            }
        },
        // The kill goes first and synchronously: a caller that does not await may start the same key right after.
        stop: async (key) => {
            const stopped = processes.stop(key);
            if ((await records.read()).some((panel) => panel.key === key)) {
                await records.update((panels) => panels.filter((panel) => panel.key !== key));
            }
            await stopped;
        },
        restore: async (env) => {
            for (const { key, spec } of await records.read()) {
                try {
                    const launch: ProcessSpec = { command: spec.command, cwd: spec.cwd, env, durable: true };
                    await processes.start(key, spec.portEnv === undefined ? launch : { ...launch, portEnv: spec.portEnv });
                } catch (error) {
                    options.logger?.warn({ err: error, key }, "panel: saved panel could not be restarted");
                }
            }
        },
    };
};
