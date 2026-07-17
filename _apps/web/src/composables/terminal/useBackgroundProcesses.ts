import { computed, type ComputedRef } from "vue";
import { useExtensions } from "../extensions/useExtensions";
import { sandboxJson } from "../sandbox/sandboxClient";
import type { TerminalTabs } from "./useTerminal";

/* The rows behind the terminal panel's background-processes popover: the installed extensions' declared
 * processes (listed even while stopped — a gated-off gateway shows as a startable row, pm2-style) merged with
 * the live "process" sessions the terminals list reports (running state + the tmux session for log views;
 * whatever maps to no declared process is dockerd or an orphaned session of an uninstalled extension).
 * Extension rows start/stop through their /extensions process routes; session-only rows can only be stopped
 * (killTerminal) — dockerd is capability-owned, its converge paths are boot and the docker capability apply. */

export interface BackgroundProcessRow {
    // Stable row key: `${extensionId}/${processName}` for declared rows, the session name otherwise.
    readonly id: string;
    // Primary display: the declared process name ("gateway"), or the session's panel key ("docker").
    readonly name: string;
    // The owning extension — present iff the row is start/stoppable through the extensions routes.
    readonly extensionId?: string;
    readonly processName?: string;
    // The live tmux session (log view target); absent while the process isn't started.
    readonly session?: string;
    readonly running: boolean;
}

// The daemon reports a just-started process as stopped until its shell consumes the buffered command
// (pane_current_command is still the shell) — one delayed relist settles the row.
const SETTLE_MS = 1500;

const processRoute = (row: BackgroundProcessRow, action: string): string =>
    `/extensions/${encodeURIComponent(row.extensionId ?? ``)}/processes/${encodeURIComponent(row.processName ?? ``)}/${action}`;

export function useBackgroundProcesses(tabs: TerminalTabs): {
    rows: ComputedRef<BackgroundProcessRow[]>;
    start: (row: BackgroundProcessRow) => Promise<void>;
    stop: (row: BackgroundProcessRow) => Promise<void>;
} {
    const { extensions } = useExtensions();

    const rows = computed<BackgroundProcessRow[]>(() => {
        const live = [...tabs.processes.value];
        const merged: BackgroundProcessRow[] = [];
        for (const extension of extensions.value) {
            for (const declared of extension.manifest.contributes?.processes ?? []) {
                const index = live.findIndex((tab) => tab.extensionId === extension.id && tab.processName === declared.name);
                const session = index >= 0 ? live.splice(index, 1)[0] : undefined;
                merged.push({
                    id: `${extension.id}/${declared.name}`,
                    name: declared.name,
                    extensionId: extension.id,
                    processName: declared.name,
                    ...(session !== undefined ? { session: session.name } : {}),
                    running: session?.running === true,
                });
            }
        }
        for (const tab of live) {
            merged.push({ id: tab.name, name: tab.label ?? tab.name, session: tab.name, running: tab.running === true });
        }
        return merged;
    });

    const relist = async (): Promise<void> => {
        await tabs.refresh();
        window.setTimeout(() => void tabs.refresh(), SETTLE_MS);
    };

    // Always stop→start (both idempotent): a crashed process leaves its session alive at a shell prompt, which
    // the panel manager still tracks — a bare start would no-op against it. Stop first covers fresh, crashed,
    // and running alike, so Start and Restart are the same call.
    const start = async (row: BackgroundProcessRow): Promise<void> => {
        await sandboxJson(processRoute(row, `stop`), { method: `POST` });
        await sandboxJson(processRoute(row, `start`), { method: `POST` });
        await relist();
    };

    const stop = async (row: BackgroundProcessRow): Promise<void> => {
        if (row.extensionId !== undefined) {
            await sandboxJson(processRoute(row, `stop`), { method: `POST` });
        } else if (row.session !== undefined) {
            await sandboxJson(`/system/terminals/${encodeURIComponent(row.session)}`, { method: `DELETE` });
        }
        await relist();
    };

    return { rows, start, stop };
}
