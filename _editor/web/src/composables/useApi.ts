import { apiContract } from "@intentic-app/api-contract";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { environment } from "../environments/environment";
import { invalidatePlatformAuth } from "./authLifecycle";

// Single typed client for the whole app, derived from the SAME apiContract the server implements. The
// browser calls the API directly at its origin; credentials: include so the Better Auth session cookie
// rides along (cross-origin, CORS-allowed).
export const apiClient: ContractRouterClient<typeof apiContract> = createORPCClient(
    new OpenAPILink(apiContract, {
        url: `${environment.api.url}/rpc`,
        fetch: async (request) => {
            const response = await globalThis.fetch(request, { credentials: `include` });
            if (response.status === 401) {
                await invalidatePlatformAuth();
            }
            return response;
        },
    }),
);
