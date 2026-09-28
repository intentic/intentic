import { errorMessage } from "@intentic/base/errors";
import { type KeyedProvider, KeyedProviderSchema, providerLabel, translatorContract, type TranslatorStatus } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../../composition.js";
import type { OrpcContext } from "../../app-env.js";
import { type ArmedCatch, armLoopbackCatch, loopbackRedirectOf, loopbackWatchers } from "../providers/accounts/loopback-bridge.js";
import { usageKey } from "../providers/translator.js";
import { withRoutedStates } from "../../usage/serviceability/serviceability.js";

export type TranslatorRoutesDeps = Pick<Services, "cliProxy" | "headroom" | "logger" | "providerRefusals" | "hostHub" | "webextHub">;

// How long a redirect sign-in's landing is watched for; the translator's own attempt lives about as long.
const REDIRECT_WATCH_MS = 15 * 60_000;

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

// Google's OAuth redirect sends the browser to a loopback address nothing in this container binds. Where a device or
// browser of the owner's can watch that address on their own machine (loopback-bridge.ts), the landing is caught there
// and handed to `complete` exactly as a paste would be; anywhere else it dead-ends and complete takes it pasted back.
// disconnect clears one account by auth-file name; a provider may hold several.
export const createTranslatorRoutes = (services: TranslatorRoutesDeps) => {
    const i = implement(translatorContract).$context<OrpcContext>();
    // Each redirect attempt's watch, by its state, until a paste or a caught landing finishes it; and how a caught
    // landing failed, since the translator's own status says ok for a credential `complete` went on to refuse.
    const watches = new Map<string, { readonly provider: KeyedProvider; readonly caught: ArmedCatch }>();
    const caughtFailures = new Map<string, string>();
    const unwatch = (state: string): void => {
        watches.get(state)?.caught.disarm();
        watches.delete(state);
    };
    const complete = async (input: { readonly provider: KeyedProvider; readonly redirectUrl: string; readonly state: string }): Promise<void> => {
        unwatch(input.state);
        caughtFailures.delete(input.state);
        await services.cliProxy.complete(input);
    };
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
        connect: i.connect.handler(async ({ input }) => {
            // Codex has both shapes: its redirect is one click where someone of the owner's watches loopback, and a
            // dead end anywhere else, where the device code is the easier thing to carry.
            const redirect = input.provider === "codex" && loopbackWatchers(services).length > 0;
            const login = await upstream(services.cliProxy.connect(input.provider, redirect ? { redirect: true } : undefined));
            // A newer attempt replaces this provider's older one, in the translator and so here.
            for (const [state, watch] of watches) {
                if (watch.provider === input.provider) {
                    unwatch(state);
                }
            }
            const loopback = login.flow === "redirect" ? loopbackRedirectOf(login.url) : undefined;
            if (loopback === undefined) {
                return login;
            }
            const caught = armLoopbackCatch(
                services,
                {
                    id: login.state,
                    ...loopback,
                    state: login.state,
                    expiresAt: Date.now() + REDIRECT_WATCH_MS,
                    title: providerLabel(input.provider),
                },
                async (url) => {
                    try {
                        await complete({ provider: input.provider, redirectUrl: url, state: login.state });
                    } catch (error) {
                        caughtFailures.set(login.state, errorMessage(error));
                        throw error;
                    }
                },
            );
            if (caught.catchers.length > 0) {
                watches.set(login.state, { provider: input.provider, caught });
            }
            return { ...login, catchers: [...caught.catchers] };
        }),
        status: i.status.handler(async ({ input }): Promise<TranslatorStatus> => {
            const failed = caughtFailures.get(input.state);
            return failed === undefined ? await upstream(services.cliProxy.status(input.provider, input.state)) : { status: "error", error: failed };
        }),
        complete: i.complete.handler(async ({ input }) => {
            await upstream(complete(input));
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
