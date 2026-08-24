import { providersContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

export type ProvidersRoutesDeps = Pick<Services, "providerCatalogs">;

// One route for every native provider's picker catalog, replacing the five that differed only in their path.
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
        models: i.models.handler(({ input }) => services.providerCatalogs[input.provider].models()),
    };
};
