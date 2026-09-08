import { onMounted, ref } from "vue";
import { sandboxJson } from "../client/sandboxClient";

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

const count = async <T>(path: string, pick: (body: T) => number | undefined): Promise<number | undefined> => {
    try {
        return pick(await sandboxJson<T>(path));
    } catch {
        return undefined;
    }
};

export function useAccessInventory() {
    const inventory = ref<AccessInventory>({});
    const loading = ref(true);

    const load = async (): Promise<void> => {
        const [webhooks, gates, ciRepos] = await Promise.all([
            count<{ automations?: { trigger?: { kind?: string } }[] }>(`/automations`, (body) =>
                body.automations === undefined ? undefined : body.automations.filter((automation) => automation.trigger?.kind === `event`).length,
            ),
            count<{ workflows?: { gate?: unknown }[] }>(`/workflows`, (body) =>
                body.workflows === undefined ? undefined : body.workflows.filter((workflow) => workflow.gate !== undefined).length,
            ),
            (async () => {
                try {
                    const { repos } = await sandboxJson<{ repos?: { hookWarning?: string }[] }>(`/ci/runs`);
                    return repos === undefined ? undefined : { total: repos.length, hooked: repos.filter((repo) => repo.hookWarning === undefined).length };
                } catch {
                    return undefined;
                }
            })(),
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
