import { apiContract } from "@intentic/api-contract";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { environment } from "../app/environments/environment";
import { accountExpectation, assertAccountCurrent, checkAnswerAccount } from "./accounts/accountBoundary";
import { invalidatePlatformAuth } from "./authLifecycle";

// Single typed client for the whole app, derived from the SAME apiContract the server implements. The
// browser calls the API directly at its origin; credentials: include so the Better Auth session cookie
// rides along (cross-origin, CORS-allowed).
//
// The cookie is the browser's, shared by every tab, and the browser may hold several accounts (accountBoundary.ts): a call
// that changes something names the account this page is drawn for, and an answer made as another account is refused here,
// before any view or this device's memory of the account's sandboxes can take it as this page's.
export const apiClient: ContractRouterClient<typeof apiContract> = createORPCClient(
    new OpenAPILink(apiContract, {
        url: `${environment.api.url}/rpc`,
        fetch: async (request) => {
            assertAccountCurrent();
            const expectation = Object.entries(accountExpectation(request.method));
            let sent = request;
            if (expectation.length > 0) {
                sent = new Request(request);
                for (const [name, value] of expectation) {
                    sent.headers.set(name, value);
                }
            }
            const response = await globalThis.fetch(sent, { credentials: `include` });
            if (response.status === 401) {
                await invalidatePlatformAuth();
            }
            await checkAnswerAccount(response);
            return response;
        },
    }),
);
