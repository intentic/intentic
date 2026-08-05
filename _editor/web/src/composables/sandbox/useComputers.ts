import { type Computer, ComputersListSchema, SyncStatusSchema } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { sandboxJson } from "./sandboxClient";
import { sandboxKey } from "./useSandbox";
import { useSandboxQuery } from "./useSandboxQuery";

/* THE COMPUTERS ON THE OTHER END OF THIS SANDBOX — every machine the daemon can see, however it can see it
 * (hosts/machine-reports.ts merges the two doors).
 *
 * This is the read that made the Desktop sync card's claims checkable. That card could say a machine was enrolled
 * and then had to print `intentic-sync status` for the rest, because the daemon genuinely did not know which
 * folder was syncing or which ports had reached localhost. Now the machines say so themselves.
 *
 * Polled rather than pushed: the facts are a snapshot of somebody's laptop and move in seconds at most, and the
 * daemon caches the half it has to pull, so a tab left open costs the far end nothing beyond that cache's TTL. */

const QUERY_KEY = sandboxKey(`computers`);
const POLL_MS = 10_000;

export function useComputers(): { computers: ComputedRef<Computer[]>; error: ComputedRef<string | undefined>; refetch: () => void } {
    const { query, error } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => ComputersListSchema.parse(await sandboxJson(`/system/computers`)),
        refetchInterval: POLL_MS,
    });
    return {
        computers: computed(() => query.data.value?.computers ?? []),
        error,
        refetch: () => void query.refetch(),
    };
}

/* How stale a machine's own reading may be before the view stops presenting it as now. The sync agent reports
 * every ~15s and the daemon re-pulls every 10s, so anything past a minute means the machine stopped talking —
 * its lid closed, its agent died — and the rows below it describe a computer that has moved on.
 *
 * The same argument as the sync card's heartbeat: a report shown as current when its machine went quiet an hour
 * ago is precisely the lie that let a lost pairing go unnoticed for days. */
const REPORT_STALE_MS = 60_000;

export const reportStale = (computer: Computer, now: number): boolean =>
    computer.report !== undefined && now - computer.report.capturedAt > REPORT_STALE_MS;

/* The rail's ambient read of the same subject — and deliberately NOT /system/computers.
 *
 * That route asks every connected computer a question over its WebSocket. Behind the Computers tab that is
 * exactly right: someone is looking. Behind the rail chip it would mean this sandbox pokes the user's laptop
 * every few seconds for as long as any page is open, forever, to decide whether to draw a badge.
 *
 * /system/sync costs the daemon nothing — the volunteered reports are already in its memory — and it carries the
 * two facts a badge can act on. So the ambient half is free, and reaching out to a machine stays a thing that
 * happens because a person opened the view that shows it. */
const HEALTH_POLL_MS = 60_000;

export function useSyncHealth(): { stoppedOn: ComputedRef<string[]>; contendedPorts: ComputedRef<number[]> } {
    const { query } = useSandboxQuery({
        queryKey: sandboxKey(`sync-health`),
        queryFn: async () => SyncStatusSchema.parse(await sandboxJson(`/system/sync`)),
        refetchInterval: HEALTH_POLL_MS,
    });
    const machines = computed(() => query.data.value?.machines ?? []);
    return {
        // A machine whose watcher died: its folder has stopped syncing and its ports have stopped being renewed,
        // while every other signal in the product still reads healthy. The exact failure that used to take days
        // to notice.
        stoppedOn: computed(() => machines.value.filter((report) => !report.watcher.running).map((report) => report.hostname)),
        // A port the sandbox serves that never reached the user's localhost because another paired sandbox holds
        // the number. "My dev server isn't on localhost" is otherwise a hunt for a process that does not exist.
        contendedPorts: computed(() => [
            ...new Set(machines.value.flatMap((report) => report.ports.filter((port) => port.state !== `mirrored`).map((port) => port.port))),
        ]),
    };
}
