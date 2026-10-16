import { runnerSlug } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { computed } from "vue";
import { RUNNERS } from "../../../lib/queryKeys";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { manageDeviceSandbox } from "./useDevices";

// This sandbox's runners: one list read by the Devices view, the Access tab and the composer's placement picker, under
// one cache key. The daemon pushes the `runners` domain whenever a runner's socket opens, closes or announces itself
// (runtime-state.ts), which refreshes it wherever it is shown.
// The poll that remains is not for that: each runner's `drift` is worked out at read time against THIS sandbox's
// settings, which no runner event announces, so a settings change would otherwise leave a stale "out of sync" line.
const DRIFT_POLL_MS = 60_000;

// Through the daemon-read wrapper: gated on the sandbox being reachable, so a daemon that is down is not asked, and
// timed and failure-mapped like every other read.
export function useRunners(poll = true) {
    const { query, error } = useSandboxQuery({
        queryKey: RUNNERS.of(),
        queryFn: () => sandboxRaw(`GET /system/runners`),
        refetchInterval: poll ? DRIFT_POLL_MS : false,
    });
    return {
        runners: computed(() => query.data.value?.runners ?? []),
        // Online runners only; an offline one keeps its row but is not offerable as a destination.
        ready: computed(() => (query.data.value?.runners ?? []).filter((runner) => runner.online)),
        isLoading: query.isLoading,
        // Whether the list has been read at all, which `runners` being empty cannot say.
        loaded: computed(() => query.data.value !== undefined),
        error,
        refetch: () => void query.refetch(),
    };
}

// Both run through manageDeviceSandbox's streaming door, so progress and refusals come from the machine
// itself. The daemon mints the pairing directly to the machine; no credential passes through the browser.
export const createRunner = (hostId: string, name: string, onLine?: (line: string) => void): Promise<string> =>
    manageDeviceSandbox(hostId, name, `runner-up`, onLine === undefined ? {} : { onLine });

export const removeRunner = (hostId: string, name: string, onLine?: (line: string) => void): Promise<string> =>
    manageDeviceSandbox(hostId, name, `runner-remove`, onLine === undefined ? {} : { onLine });

// A runner is an ordinary sandbox container, updated via the same `update` flow (addressed by runnerSlug)
// rather than its own verb. Its enrollment lives on the volume, so identity survives the update.
export const updateRunner = (hostId: string, name: string, onLine?: (line: string) => void): Promise<string> =>
    manageDeviceSandbox(hostId, runnerSlug(name), `update`, onLine === undefined ? {} : { onLine });

// Drops this runner's enrollment and closes its socket from this side alone, for when the machine itself
// is gone for good.
export const forgetRunner = async (id: string): Promise<void> => {
    await sandboxRaw(`DELETE /system/runners/{id}`, { params: { id } });
};

// Pushes this sandbox's settings onto the runner over its live link, settings only. An overlay change
// needs a remove-and-re-add instead, since that rebuilds the container. A refusal (an offline runner's 409) throws.
export const syncRunnerSettings = async (id: string): Promise<void> => {
    await sandboxRaw(`POST /system/runners/{id}/definition/sync`, { params: { id } });
};
