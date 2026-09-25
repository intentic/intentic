import { errorMessage } from "@intentic/base/errors";
import { KeyedProviderSchema, translatorContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../../composition.js";
import type { OrpcContext } from "../../app-env.js";
import { usageKey } from "../providers/translator.js";
import { withRoutedStates } from "../../usage/serviceability/serviceability.js";

export type TranslatorRoutesDeps = Pick<Services, "cliProxy" | "headroom" | "logger" | "providerRefusals">;

// oRPC replaces a non-ORPCError throw's message with a generic 'Internal server error'; these handlers rethrow the
// translator's own message instead. 502 marks a failure from the bundled proxy itself, not the daemon.
const upstream = async <T>(action: Promise<T>): Promise<T> => {
    try {
        return await action;
    } catch (error) {
        // Already an ORPCError: the status was chosen on purpose; do not relabel it as a gateway fault.
        if (error instanceof ORPCError) {
            throw error;
        }
        throw new ORPCError("BAD_GATEWAY", { message: errorMessage(error) });
    }
};

// Google's OAuth redirect dead-ends on a loopback URL only this container binds, so complete takes it pasted back
// instead of following it. disconnect clears one account by auth-file name; a provider may hold several.
export const createTranslatorRoutes = (services: TranslatorRoutesDeps) => {
    const i = implement(translatorContract).$context<OrpcContext>();
    return {
        accounts: i.accounts.handler(async () => {
            const accounts = await upstream(services.cliProxy.accounts());
            // Not awaited: also gates routed-turn credentials and broadcasts the refresh to every open /events window.
            void services.headroom.refresh({ scope: { providers: KeyedProviderSchema.options } });
            // The list is read right after a sign-in and on every visit to a headroom surface, which makes it the one
            // place a credential that can serve no turn is certain to pass through before it catches one.
            void services.cliProxy
                .benchUnusable()
                .then((benched) =>
                    benched.length === 0 ? undefined : services.logger.warn({ accounts: benched }, "translator: benched credentials that can serve no turn"),
                )
                .catch((error: unknown) => services.logger.warn({ err: error }, "translator: could not bench unusable credentials"));
            // Each credential carries the one serviceability verdict, bench and the provider's last refusal included.
            return withRoutedStates(services, accounts);
        }),
        connect: i.connect.handler(({ input }) => upstream(services.cliProxy.connect(input.provider))),
        status: i.status.handler(({ input }) => upstream(services.cliProxy.status(input.provider, input.state))),
        complete: i.complete.handler(async ({ input }) => {
            await upstream(services.cliProxy.complete(input));
            return { ok: true } as const;
        }),
        disconnect: i.disconnect.handler(async ({ input }) => {
            await upstream(services.cliProxy.disconnect(input.provider, input.name));
            // Also clears the dropped account's headroom snapshot, keyed by its auth-file name.
            await services.headroom.clear(input.provider, usageKey(input.provider, input.name));
            return { ok: true } as const;
        }),
    };
};
