import type { NoticeModel } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef } from "vue";
import { useExtensions } from "../extensions/useExtensions";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { useOperations } from "../../workbench/operations/operations";
import { KINDS } from "./terminalMeta";
import { useTerminalsQuery } from "./terminalsQuery";
import { useTerminalPanel } from "./useTerminalPanel";

// Background-process rows: extensions' declared processes (listed even while stopped) merged with the daemon's live
// `process` sessions. Extension rows start/stop via the extensions routes; session-only rows can only be stopped. Backed
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

// Where the operations ledger keeps a row's start, restart or stop: the sandbox's process, not the popover that pressed
// it, so a second surface (the popover, the Capabilities page) shows the same press held, and its refusal is kept.
export const PROCESS_PRESSES = `terminal/processes`;

// Delayed relist after an action, to catch a service that reports running then crashes instantly.
const SETTLE_MS = 1500;
// Only a declared row addresses the extensions routes; a session-only row has no process to name.
const processOf = (row: BackgroundProcessRow): { id: string; name: string } => {
    if (row.extensionId === undefined || row.processName === undefined) {
        throw new Error(`Background process ${row.id} is not an extension's declared process, so it can't be started or stopped by name.`);
    }
    return { id: row.extensionId, name: row.processName };
};

// Opens a row's read-only logs via the global panel channel rather than a local tab call, so it works with no panel
// mounted.
export const viewProcessLogs = (row: BackgroundProcessRow): void => {
    if (row.session !== undefined) {
        useTerminalPanel().openFocused(row.session);
    }
};

export function useBackgroundProcesses(): {
    rows: ComputedRef<BackgroundProcessRow[]>;
    // The row an action was last started for while it runs; its buttons disable to block a double-click restart. One
    // row, for a caller that compares it with each (Capabilities); `pressing` answers for any row.
    busy: ComputedRef<string | undefined>;
    pressing: (row: BackgroundProcessRow) => boolean;
    // Why a row's last press failed, until that row is pressed again or the failure is put away.
    failure: (row: BackgroundProcessRow) => NoticeModel | undefined;
    dismiss: (row: BackgroundProcessRow) => void;
    start: (row: BackgroundProcessRow) => Promise<void>;
    stop: (row: BackgroundProcessRow) => Promise<void>;
} {
    const { extensions } = useExtensions();
    const { sessions, refetch } = useTerminalsQuery();
    const presses = useOperations(PROCESS_PRESSES);
    const busy = computed(() => presses.all.value.findLast((press) => press.state === `running`)?.tag);
    const pressing = (row: BackgroundProcessRow): boolean => presses.at(row.id)?.state === `running`;

    const rows = computed<BackgroundProcessRow[]>(() => {
        const live = sessions.value.filter((session) => KINDS[session.kind].logs);
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

    // Holds the row across one action, so callers don't have to manage it themselves, and keeps its refusal: it used
    // to be thrown at a click handler, and so said nowhere. The relist is part of the press: the row reads its outcome.
    const act = async (row: BackgroundProcessRow, what: string, failed: string, run: () => Promise<void>): Promise<void> => {
        if (pressing(row)) {
            return;
        }
        await presses.run(row.id, {
            what,
            tag: row.id,
            failed,
            task: async () => {
                await run();
                await relist();
            },
        });
    };

    // Always stop then start, both idempotent: a plain start no-ops on a tracked (even backoff-retrying) key, so this
    // covers fresh, crashed, and running alike with one call.
    const start = (row: BackgroundProcessRow): Promise<void> =>
        act(
            row,
            row.running
                ? t(`terminal.backgroundProcesses.restarting`, { name: row.name })
                : t(`terminal.backgroundProcesses.starting`, { name: row.name }),
            t(`terminal.backgroundProcesses.couldntStart`, { name: row.name }),
            async () => {
                await sandboxRpc.extensions.processStop(processOf(row));
                await sandboxRpc.extensions.processStart(processOf(row));
            },
        );

    const stop = (row: BackgroundProcessRow): Promise<void> =>
        act(
            row,
            t(`terminal.backgroundProcesses.stopping`, { name: row.name }),
            t(`terminal.backgroundProcesses.couldntStop`, { name: row.name }),
            async () => {
                if (row.extensionId !== undefined) {
                    await sandboxRpc.extensions.processStop(processOf(row));
                    return;
                }
                if (row.session !== undefined) {
                    await sandboxRpc.system.killTerminal({ name: row.session });
                }
            },
        );

    return {
        rows,
        busy,
        pressing,
        failure: (row) => presses.at(row.id)?.failure,
        dismiss: (row) => presses.dismiss(row.id),
        start,
        stop,
    };
}
