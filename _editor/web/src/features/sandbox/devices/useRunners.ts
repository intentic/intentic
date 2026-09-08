import { useQuery } from "@tanstack/vue-query";
import { RunnerSummarySchema, runnerSlug } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { z } from "zod";
import { RUNNERS } from "../../../lib/queryKeys";
import { sandboxJson, sandboxRequest } from "../client/sandboxClient";
import { manageDeviceSandbox } from "./useDevices";

// This sandbox's runners (docs/remote-runners-plan.md): one list read by the Devices view and the
// composer's placement picker. Polled slowly, since online/busy status rarely needs finer resolution.
const POLL_MS = 15_000;

const RunnersSchema = z.object({ runners: z.array(RunnerSummarySchema) });

export function useRunners(poll = true) {
    const query = useQuery({
        queryKey: RUNNERS.of(),
        queryFn: async () => RunnersSchema.parse(await sandboxJson(`/system/runners`)),
        refetchInterval: poll ? POLL_MS : false,
    });
    return {
        runners: computed(() => query.data.value?.runners ?? []),
        // Online runners only; an offline one keeps its row but is not offerable as a destination.
        ready: computed(() => (query.data.value?.runners ?? []).filter((runner) => runner.online)),
        isLoading: query.isLoading,
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
    await sandboxRequest(`/system/runners/${encodeURIComponent(id)}`, { method: `DELETE` });
};

// Pushes this sandbox's settings onto the runner over its live link, settings only. An overlay change
// needs a remove-and-re-add instead, since that rebuilds the container.
export const syncRunnerSettings = async (id: string): Promise<void> => {
    await sandboxRequest(`/system/runners/${encodeURIComponent(id)}/definition/sync`, { method: `POST` });
};
