import { endpointProvider, isTrialProvider, providersContract, TRIAL_LABEL } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../../composition.js";
import type { OrpcContext } from "../../app-env.js";

export type ProvidersRoutesDeps = Pick<Services, "providerCatalogs" | "capabilities">;

// What a chat can be addressed to here: the providers this box adds to the fixed native list, and any one provider's
// picker catalog (one route, replacing the five that differed only in their path).
// The provider in the path is closed to NATIVE_PROVIDERS by the contract, so the lookup below cannot miss,
// which is the point of closing it there rather than validating here.
//
// No error arm: each catalog resolves down to a seed floor and is never empty (each provider module's own
// catalog says how), so
// there is no "this provider has nothing" state to report. An endpoint's catalog CAN be empty and CAN name a
// capability that does not exist, which is why it kept its own route.
export const createProvidersRoutes = (services: ProvidersRoutesDeps) => {
    const i = implement(providersContract).$context<OrpcContext>();
    return {
        // The two capability kinds that mint a provider, and nothing else about them: every surface that offers a chat
        // a provider reads this, including the tiers that may drive a turn but not see what this box connects to.
        list: i.list.handler(async () => {
            const capabilities = await services.capabilities.list();
            return {
                agents: capabilities.flatMap((capability) =>
                    capability.kind === "agent" ? [{ id: capability.id, label: capability.config.name ?? capability.id }] : [],
                ),
                endpoints: capabilities.flatMap((capability) => {
                    if (capability.kind !== "endpoint" && capability.kind !== "localmodel") {
                        return [];
                    }
                    const id = endpointProvider(capability.id);
                    // The trial is the one endpoint the user didn't name, so it is the one whose label isn't its id.
                    return [{ id, label: isTrialProvider(id) ? TRIAL_LABEL : capability.id, kind: capability.kind }];
                }),
            };
        }),
        models: i.models.handler(({ input }) => services.providerCatalogs[input.provider].models()),
    };
};
