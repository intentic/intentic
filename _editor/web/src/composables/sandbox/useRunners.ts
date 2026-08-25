import { useQuery } from "@tanstack/vue-query";
import { RunnerSummarySchema, runnerSlug } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { z } from "zod";
import { RUNNERS } from "../queryKeys";
import { sandboxJson, sandboxRequest } from "./sandboxClient";
import { manageMachineSandbox } from "./useComputers";

/* THIS SANDBOX'S RUNNERS: the machines it can hand a conversation to (docs/remote-runners-plan.md in the
 * workspace). One list, read by both surfaces that care, the Computers view (which offers to make and remove
 * them) and the composer's placement picker (which offers to run there).
 *
 * Polled, and slowly. A runner's row says two things that change on their own, whether it is online and how
 * busy it is, and neither is worth a request every few seconds: a laptop that just woke is interesting within
 * half a minute, and a load average is a glance, not a graph. */
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
        // The ones a conversation can actually be placed on right now. An offline runner keeps its row (it is
        // still paired, and its machine may simply be asleep) but must not be offered as a destination: a turn
        // sent there would only come back as the "wake it" refusal.
        ready: computed(() => (query.data.value?.runners ?? []).filter((runner) => runner.online)),
        isLoading: query.isLoading,
        refetch: () => void query.refetch(),
    };
}

/* Making one, and unmaking it, both through the machine that will hold it: the same streaming door every other
 * container action on a connected computer takes (useComputers.manageMachineSandbox), so progress arrives line
 * by line while `ic` pulls an image, and a refusal arrives as that machine's own sentence naming the switch to
 * flip. The PAIRING is never here: the daemon mints it and hands it to the machine itself, so no credential
 * passes through the browser. */
export const createRunner = (hostId: string, name: string, onLine?: (line: string) => void): Promise<string> =>
    manageMachineSandbox(hostId, name, `runner-up`, onLine === undefined ? {} : { onLine });

export const removeRunner = (hostId: string, name: string, onLine?: (line: string) => void): Promise<string> =>
    manageMachineSandbox(hostId, name, `runner-remove`, onLine === undefined ? {} : { onLine });

/* BRINGING AN OUTDATED RUNNER UP TO THE PARENT'S BUILD. It is an ordinary sandbox container on that machine,
 * so this is the ordinary `update` flow addressed by the runner's container name (runnerSlug) rather than a
 * verb of its own: the same pull, the same recreate, and the runner's identity survives it because its
 * enrollment lives on the volume the update keeps. */
export const updateRunner = (hostId: string, name: string, onLine?: (line: string) => void): Promise<string> =>
    manageMachineSandbox(hostId, runnerSlug(name), `update`, onLine === undefined ? {} : { onLine });

// Cut a runner loose from THIS side alone: its enrollment goes and its socket closes, which is what you press
// when the machine itself is gone for good and there is nothing left to remove a container from.
export const forgetRunner = async (id: string): Promise<void> => {
    await sandboxRequest(`/system/runners/${encodeURIComponent(id)}`, { method: `DELETE` });
};

// Push this sandbox's settings onto one runner over its live link — the fix for the "Setting …" drift lines
// its summary carries. Settings only: an overlay line takes a remove-and-re-add, which rebuilds the container.
export const syncRunnerSettings = async (id: string): Promise<void> => {
    await sandboxRequest(`/system/runners/${encodeURIComponent(id)}/definition/sync`, { method: `POST` });
};
