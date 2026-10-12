import { type Deployment, DeploymentSchema } from "@intentic/api-contract";
import { computed } from "vue";
import { untilResult } from "../../lib/intenticStream";
import { SandboxHttpError } from "../../client/sandbox/sandboxHttpError";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { DEPLOYMENTS } from "../../lib/queryKeys";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { t } from "@intentic/ui/i18n";

/* The live Komodo deployments surfaced by the in-sandbox `intentic deploy deployments` subcommand. */

// Run `intentic deploy deployments` in the sandbox and validate the terminal result line. `komodoReachable` is the
// CLI's own verdict on the deployment engine, TRI-STATE: undefined = no komodo declared (services-only
// intents have no deployment engine, nothing to be "down"); false = declared but didn't answer (the list is
// desired config only, nothing is `live`); true = answered. Surfaced so the UI can say "your deploy engine is
// down" without crying wolf on setups that never had one.
// A run that failed, or ended without its result line, is a failed read: never an empty list of deployments.
const fetchDeployments = async (): Promise<{ deployments: Deployment[]; komodoReachable: boolean | undefined }> => {
    const lines = await sandboxRpc.intentic.run({ args: [`deploy`, `deployments`] }).catch((error: unknown) => {
        throw error instanceof SandboxHttpError
            ? new Error(t(`extensions.useDeployments.couldNotLoad`, { status: error.status, message: error.message }))
            : error;
    });
    const result = await untilResult(lines, {
        failed: () => t(`extensions.useDeployments.listingFailed`),
        ended: () => t(`extensions.useDeployments.noAnswer`),
    });
    const deployments = result[`deployments`];
    if (!Array.isArray(deployments)) {
        throw new Error(t(`extensions.useDeployments.noAnswer`));
    }
    const komodoReachable = typeof result[`komodoReachable`] === `boolean` ? result[`komodoReachable`] : undefined;
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
