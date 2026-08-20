import { type Deployment, DeploymentSchema } from "@intentic-app/api-contract";
import { computed } from "vue";
import { readIntenticLines } from "../intenticStream";
import { sandboxRequest } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";
import { DEPLOYMENTS } from "../queryKeys";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* The live Komodo deployments surfaced by the in-sandbox `intentic deploy deployments` subcommand, read DIRECTLY
 * from the daemon (the sandbox already merges desired-state with live Komodo). Shared by the infrastructure +
 * live-status extensions through the app-wide query cache. */

// Run `intentic deploy deployments` in the sandbox and validate the terminal result line. `komodoReachable` is the
// CLI's own verdict on the deployment engine, TRI-STATE: undefined = no komodo declared (services-only
// intents have no deployment engine, nothing to be "down"); false = declared but didn't answer (the list is
// desired config only, nothing is `live`); true = answered. Surfaced so the UI can say "your deploy engine is
// down" without crying wolf on setups that never had one.
const fetchDeployments = async (): Promise<{ deployments: Deployment[]; komodoReachable: boolean | undefined }> => {
    const response = await sandboxRequest(`/intentic`, jsonBody(`POST`, { args: [`deploy`, `deployments`] }));
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
    const { query, error } = useSandboxQuery({
        queryKey: DEPLOYMENTS.of(),
        queryFn: fetchDeployments,
    });

    return {
        deployments: computed<Deployment[]>(() => query.data.value?.deployments ?? []),
        // undefined until the first read answers; false = the engine is down and `live` flags are meaningless.
        komodoReachable: computed(() => query.data.value?.komodoReachable),
        error,
        isLoading: query.isLoading,
        refetch: query.refetch,
    };
}
