import { type Deployment, DeploymentSchema } from "@intentic-app/api-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { readIntenticLines } from "../intenticStream";
import { sandboxRequest } from "../sandbox/sandboxClient";
import { sandboxKey, useSandbox } from "../sandbox/useSandbox";

/* The live Komodo deployments surfaced by the in-sandbox `intentic deployments` subcommand, read DIRECTLY
 * from the daemon (the sandbox already merges desired-state with live Komodo). Shared by the infrastructure +
 * live-status extensions through the app-wide query cache. */

// Run `intentic deployments` in the sandbox and validate the terminal result line. `komodoReachable` is the
// CLI's own verdict on the deployment engine, TRI-STATE: undefined = no komodo declared (services-only
// intents have no deployment engine — nothing to be "down"); false = declared but didn't answer (the list is
// desired config only, nothing is `live`); true = answered. Surfaced so the UI can say "your deploy engine is
// down" without crying wolf on setups that never had one.
const fetchDeployments = async (): Promise<{ deployments: Deployment[]; komodoReachable: boolean | undefined }> => {
    const response = await sandboxRequest(`/intentic`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({ args: [`deployments`] }),
    });
    if (!response.ok || !response.body) {
        throw new Error(`Could not load your deployments (${response.status}).`);
    }
    let deployments: unknown = [];
    let komodoReachable: boolean | undefined;
    for await (const line of readIntenticLines(response.body)) {
        if (line[`kind`] === `result` && Array.isArray(line[`deployments`])) {
            deployments = line[`deployments`];
            komodoReachable = typeof line[`komodoReachable`] === `boolean` ? line[`komodoReachable`] : undefined;
        }
    }
    return { deployments: DeploymentSchema.array().parse(deployments), komodoReachable };
};

export function useDeployments() {
    const { reachable } = useSandbox();
    const query = useQuery({
        queryKey: sandboxKey(`deployments`),
        queryFn: fetchDeployments,
        enabled: reachable,
    });

    return {
        deployments: computed<Deployment[]>(() => query.data.value?.deployments ?? []),
        // undefined until the first read answers; false = the engine is down and `live` flags are meaningless.
        komodoReachable: computed(() => query.data.value?.komodoReachable),
        error: computed(() => (query.error.value ? query.error.value.message : null)),
        isLoading: query.isLoading,
        refetch: query.refetch,
    };
}
