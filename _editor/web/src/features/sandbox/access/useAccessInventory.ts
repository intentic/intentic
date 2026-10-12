import { RunnerSummarySchema } from "@intentic/sandbox-contract";
import { onMounted, ref } from "vue";
import { z } from "zod";
import { sandboxJson } from "../../../client/sandbox/sandboxClient";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";

// Counts every machine door into the sandbox besides a person or control token (webhooks, workflow gates, CI hooks,
// paired machines),
// for the Access tab's "what still has a way in" question. Reads and counts only; each list is best-effort, unknown
// rather than failing the tab.

export interface AccessInventory {
    // Event automations, each reachable at /automations/{id}/fire with its own token.
    readonly webhooks?: number;
    // Workflows that declare a release gate, each reachable at /workflows/{id}/gate with its own token.
    readonly gates?: number;
    // Repositories wired to a forge, and how many of those had their CI webhook registered by the sandbox.
    readonly ciRepos?: { readonly total: number; readonly hooked: number };
    // Machines enrolled with this sandbox (devices and runners), each holding its own enrollment key.
    readonly paired?: { readonly devices: number; readonly runners: number };
}

const RunnersSchema = z.object({ runners: z.array(RunnerSummarySchema) });

// What one read counts, or undefined when it could not be read at all.
const countOf = async <T, C>(read: () => Promise<T>, pick: (answer: T) => C): Promise<C | undefined> => {
    try {
        return pick(await read());
    } catch {
        return undefined;
    }
};

export function useAccessInventory() {
    const inventory = ref<AccessInventory>({});
    const loading = ref(true);

    const load = async (): Promise<void> => {
        const [webhooks, gates, ciRepos, devices, runners] = await Promise.all([
            countOf(
                () => sandboxRpc.automations.list(),
                ({ automations }) => automations.filter((automation) => automation.trigger.kind === `event`).length,
            ),
            countOf(
                () => sandboxRpc.workflows.list(),
                ({ workflows }) => workflows.filter((workflow) => workflow.gate !== undefined).length,
            ),
            countOf(
                () => sandboxRpc.ci.runs(),
                ({ repos }) => ({ total: repos.length, hooked: repos.filter((repo) => repo.hookWarning === undefined).length }),
            ),
            countOf(
                () => sandboxRpc.system.devices(),
                (answer) => answer.devices.length,
            ),
            countOf(
                async () => RunnersSchema.parse(await sandboxJson(`/system/runners`)),
                (answer) => answer.runners.length,
            ),
        ]);
        const counted: { -readonly [K in keyof AccessInventory]: AccessInventory[K] } = {};
        if (webhooks !== undefined) {
            counted.webhooks = webhooks;
        }
        if (gates !== undefined) {
            counted.gates = gates;
        }
        if (ciRepos !== undefined) {
            counted.ciRepos = ciRepos;
        }
        if (devices !== undefined && runners !== undefined) {
            counted.paired = { devices, runners };
        }
        inventory.value = counted;
        loading.value = false;
    };

    onMounted(() => void load());

    return { inventory, loading, reload: load };
}
