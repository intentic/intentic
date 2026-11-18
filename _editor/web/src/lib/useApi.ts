import { ACCOUNT_HEADER, apiContract } from "@intentic/api-contract";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { environment } from "../app/environments/environment";
import { accountExpectation, assertAccountCurrent, checkAnswerAccount } from "./accounts/accountBoundary";
import { invalidatePlatformAuth } from "./authLifecycle";
import { reportedFetch } from "./platform/platformHealth";

// Single typed client for the whole app, derived from the SAME apiContract the server implements. The
// browser calls the API directly at its origin; credentials: include so the Better Auth session cookie
// rides along (cross-origin, CORS-allowed).
//
// The cookie is the browser's, shared by every tab, and the browser may hold several accounts (accountBoundary.ts): a call
// that changes something names the account this page is drawn for, and an answer made as another account is refused here,
// before any view or this device's memory of the account's sandboxes can take it as this page's.
export interface ApiCallContext {
    // A read asked before the session check has answered, on the guess that there is a session (useAuth's sign-in
    // methods): its 401 says only that there was none, which the session check answers for itself, so it does not tear the
    // window down the way a 401 to a signed-in call does.
    readonly ahead?: boolean;
    // Told which account the platform answered as (ACCOUNT_HEADER; null when the answer names nobody), for a read `ahead`
    // whose answer is kept until the page knows whose it is (useSandbox's list, asked beside the session check).
    readonly answeredAs?: (account: string | null) => void;
}

export const apiClient: ContractRouterClient<typeof apiContract, ApiCallContext> = createORPCClient(
    new OpenAPILink<ApiCallContext>(apiContract, {
        url: `${environment.api.url}/rpc`,
        fetch: async (request, _init, { context }) => {
            assertAccountCurrent();
            const expectation = Object.entries(accountExpectation(request.method));
            let sent = request;
            if (expectation.length > 0) {
                sent = new Request(request);
                for (const [name, value] of expectation) {
                    sent.headers.set(name, value);
                }
            }
            // Every answer, and every call nothing answered, is reported to the one reading of the platform's health.
            const response = await reportedFetch(() => globalThis.fetch(sent, { credentials: `include` }));
            // The api's own refusal is JSON (oRPC's error body); a 401 from anything in front of it (a proxy's page, a
            // captive portal's) is not the platform saying the session ended, and must not tear the window down.
            if (response.status === 401 && context.ahead !== true && (response.headers.get(`content-type`) ?? ``).includes(`json`)) {
                await invalidatePlatformAuth();
            }
            await checkAnswerAccount(response);
            context.answeredAs?.(response.headers.get(ACCOUNT_HEADER));
            return response;
        },
    }),
);
