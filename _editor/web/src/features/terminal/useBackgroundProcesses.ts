import { computed, type ComputedRef, ref, type Ref } from "vue";
import { useExtensions } from "../extensions/useExtensions";
import { sandboxJson } from "../sandbox/client/sandboxClient";
import { useTerminalsQuery } from "./terminalsQuery";
import { useTerminalPanel } from "./useTerminalPanel";

// Background-process rows: extensions' declared processes (listed even while stopped) merged with the daemon's live
// `process` sessions. Extension rows start/stop via /extensions routes; session-only rows can only be stopped. Backed
// by the shared terminals query, not a mounted panel: health is a sandbox fact any surface can ask.

export interface BackgroundProcessRow {
    // Stable row key: `${extensionId}/${processName}` for declared rows, the session name otherwise.
    readonly id: string;
    // Display name: the declared process name, or the session's panel key.
    readonly name: string;
    // Owning extension; present only if the row is start/stoppable via the extensions routes.
    readonly extensionId?: string;
    readonly processName?: string;
    // Live tmux session (log-view target); absent while the process isn't started.
    readonly session?: string;
    readonly running: boolean;
}

// Delayed relist after an action, to catch a service that reports running then crashes instantly.
const SETTLE_MS = 1500;
const processRoute = (row: BackgroundProcessRow, action: string): string =>
    `/extensions/${encodeURIComponent(row.extensionId ?? ``)}/processes/${encodeURIComponent(row.processName ?? ``)}/${action}`;

// Opens a row's read-only logs via the global panel channel rather than a local tab call, so it works with no panel
// mounted.
export const viewProcessLogs = (row: BackgroundProcessRow): void => {
    if (row.session !== undefined) {
        useTerminalPanel().openFocused(row.session);
    }
};

export function useBackgroundProcesses(): {
    rows: ComputedRef<BackgroundProcessRow[]>;
    // Row an action is in flight for; its buttons disable while set to block a double-click restart.
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

    // Holds `busy` for the row across one action, so callers don't have to manage it themselves.
    const act = async (row: BackgroundProcessRow, run: () => Promise<void>): Promise<void> => {
        busy.value = row.id;
        try {
            await run();
            await relist();
        } finally {
            busy.value = undefined;
        }
    };

    // Always stop then start, both idempotent: a plain start no-ops on a tracked (even backoff-retrying) key, so this
    // covers fresh, crashed, and running alike with one call.
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
