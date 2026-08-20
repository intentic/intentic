import { computed, type ComputedRef, ref, type Ref } from "vue";
import { useExtensions } from "../extensions/useExtensions";
import { sandboxJson } from "../sandbox/sandboxClient";
import { useTerminalsQuery } from "./terminalsQuery";
import { useTerminalPanel } from "./useTerminalPanel";

/* The managed background processes, as rows any surface can render: the installed extensions' DECLARED
 * processes (listed even while stopped, a gated-off gateway shows as a startable row, pm2-style) merged with
 * the live "process" sessions the daemon's terminal list reports (running state + the tmux session for log
 * views; whatever maps to no declared process is dockerd or an orphaned session of an uninstalled extension).
 * Extension rows start/stop through their /extensions process routes; session-only rows can only be stopped
 * (dockerd is daemon-owned, part of the base sandbox, so its converge path is the daemon's boot).
 *
 * State comes from the shared terminals query, NOT from a mounted terminal panel: a process's health is a
 * sandbox fact, and the surface that should answer "is my Discord bot alive?" is the Discord capability card,
 * which has no tab machinery. The panel's popover is one more caller of the same rows. */

export interface BackgroundProcessRow {
    // Stable row key: `${extensionId}/${processName}` for declared rows, the session name otherwise.
    readonly id: string;
    // Primary display: the declared process name ("gateway"), or the session's panel key ("docker").
    readonly name: string;
    // The owning extension, present iff the row is start/stoppable through the extensions routes.
    readonly extensionId?: string;
    readonly processName?: string;
    // The live tmux session (log view target); absent while the process isn't started.
    readonly session?: string;
    readonly running: boolean;
}

// The daemon reports a just-started process as stopped until its shell consumes the buffered command
// (pane_current_command is still the shell), one delayed relist settles the row.
const SETTLE_MS = 1500;
const processRoute = (row: BackgroundProcessRow, action: string): string =>
    `/extensions/${encodeURIComponent(row.extensionId ?? ``)}/processes/${encodeURIComponent(row.processName ?? ``)}/${action}`;

// Open a row's read-only logs. Plain action, not composable state, and routed through the GLOBAL panel channel
// rather than a local tab call so it works from a page with no panel mounted: focus() recognises a process
// session and opens its read-only log view rather than tabbing it directly.
export const viewProcessLogs = (row: BackgroundProcessRow): void => {
    if (row.session !== undefined) {
        useTerminalPanel().openFocused(row.session);
    }
};

export function useBackgroundProcesses(): {
    rows: ComputedRef<BackgroundProcessRow[]>;
    // The row an action is in flight for, its buttons disable so a double-click can't double-restart.
    busy: Ref<string | undefined>;
    start: (row: BackgroundProcessRow) => Promise<void>;
    stop: (row: BackgroundProcessRow) => Promise<void>;
} {
    const { extensions } = useExtensions();
    const { sessions, refetch } = useTerminalsQuery();
    const busy = ref<string | undefined>(undefined);

    const rows = computed<BackgroundProcessRow[]>(() => {
        const live = sessions.value.filter((session) => session.kind === `process`);
        const merged: BackgroundProcessRow[] = [];
        for (const extension of extensions.value) {
            for (const declared of extension.manifest.contributes?.processes ?? []) {
                const index = live.findIndex((session) => session.extensionId === extension.id && session.processName === declared.name);
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
        for (const session of live) {
            merged.push({ id: session.name, name: session.label ?? session.name, session: session.name, running: session.running });
        }
        return merged;
    });

    const relist = async (): Promise<void> => {
        await refetch();
        window.setTimeout(() => void refetch(), SETTLE_MS);
    };

    // Every action holds `busy` for its own row, so no caller has to wrap it.
    const act = async (row: BackgroundProcessRow, run: () => Promise<void>): Promise<void> => {
        busy.value = row.id;
        try {
            await run();
            await relist();
        } finally {
            busy.value = undefined;
        }
    };

    // Always stop→start (both idempotent): a crashed process leaves its session alive at a shell prompt, which
    // the panel manager still tracks, a bare start would no-op against it. Stop first covers fresh, crashed,
    // and running alike, so Start and Restart are the same call.
    const start = (row: BackgroundProcessRow): Promise<void> =>
        act(row, async () => {
            await sandboxJson(processRoute(row, `stop`), { method: `POST` });
            await sandboxJson(processRoute(row, `start`), { method: `POST` });
        });

    const stop = (row: BackgroundProcessRow): Promise<void> =>
        act(row, async () => {
            if (row.extensionId !== undefined) {
                await sandboxJson(processRoute(row, `stop`), { method: `POST` });
                return;
            }
            if (row.session !== undefined) {
                await sandboxJson(`/system/terminals/${encodeURIComponent(row.session)}`, { method: `DELETE` });
            }
        });

    return { rows, busy, start, stop };
}
