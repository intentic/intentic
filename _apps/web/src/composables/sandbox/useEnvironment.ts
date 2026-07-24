import { EnvironmentSchema } from "@intentic-app/api-contract";
import { computed } from "vue";
import { bashCommand } from "../../environments/scriptCommand";
import { sandboxJson } from "./sandboxClient";
import { sandboxKey } from "./useSandbox";
import { useSandboxQuery } from "./useSandboxQuery";

/* The sandbox's composed environment overlay (.intentic/environment.approved.Dockerfile), read via the daemon's
 * /environment route. Shared by the Environment card, the shell's rebuild banner, and the capabilities page so
 * "a rebuild is pending" / "a proposal awaits review" derives from ONE query (vue-query dedupes on the key). */

export const ENVIRONMENT_KEY = sandboxKey(`environment`);

export function useEnvironment() {
    const { query } = useSandboxQuery({
        queryKey: ENVIRONMENT_KEY,
        queryFn: async () => EnvironmentSchema.parse(await sandboxJson(`/environment`)),
    });
    const state = computed(() => query.data.value);

    // A proposal awaiting review: present and not the custom-section content already approved.
    const proposal = computed(() => {
        const current = state.value;
        return current?.proposal !== undefined && current.proposal.hash !== current.custom?.hash ? current.proposal : undefined;
    });
    // Approved but not what the running container was built from — a rebuild is pending.
    const pending = computed(() => {
        const current = state.value;
        return current?.approved !== undefined && current.approved.hash !== current.appliedHash ? current.approved : undefined;
    });
    const applied = computed(() => {
        const current = state.value;
        return current?.approved !== undefined && current.approved.hash === current.appliedHash ? current.approved : undefined;
    });

    // Server-managed sandboxes use the provider's fixed container name; their rebuild rides `intentic deploy apply`
    // (the overlay content is git-reviewed in desired-state), not a local one-liner.
    const serverManaged = computed(() => state.value?.container === `intentic-sandbox-workspace`);
    const rebuildCommand = computed(() => {
        const slug = state.value?.container?.replace(/^intentic-sandbox-/, ``);
        return slug !== undefined && pending.value !== undefined ? bashCommand(`rebuild`, ``, `${slug} ${pending.value.hash}`) : ``;
    });

    return { state, query, proposal, pending, applied, serverManaged, rebuildCommand };
}
