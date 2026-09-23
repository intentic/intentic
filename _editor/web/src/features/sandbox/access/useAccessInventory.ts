import { onMounted, ref } from "vue";
import { sandboxRpc } from "../client/sandboxRpc";

// Counts every machine door into the sandbox besides a person or control token (webhooks, workflow gates, CI hooks),
// for the Access tab's "what still has a way in" question. Reads and counts only; each list is best-effort, unknown
// rather than failing the tab.

export interface AccessInventory {
    // Event automations, each reachable at /automations/{id}/fire with its own token.
    readonly webhooks?: number;
    // Workflows that declare a release gate, each reachable at /workflows/{id}/gate with its own token.
    readonly gates?: number;
    // Repositories wired to a forge, and how many of those had their CI webhook registered by the sandbox.
    readonly ciRepos?: { readonly total: number; readonly hooked: number };
}

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
        const [webhooks, gates, ciRepos] = await Promise.all([
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
        ]);
        inventory.value = {
            ...(webhooks === undefined ? {} : { webhooks }),
            ...(gates === undefined ? {} : { gates }),
            ...(ciRepos === undefined ? {} : { ciRepos }),
        };
        loading.value = false;
    };

    onMounted(() => void load());

    return { inventory, loading, reload: load };
}
