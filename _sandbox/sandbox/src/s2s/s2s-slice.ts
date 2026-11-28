import type { CompositionCore, Services } from "../composition.js";
import { rosterReader } from "../auth/members/member-caller.js";
import { defineSlice } from "../seams/slice.js";
import { nodeTxtResolver } from "./identity/identity-domains.js";
import { createS2s, type S2s } from "./s2s-service.js";
import { publicAddressOf } from "../env.config.js";
import { hostProblem, hostUrl, identityFetcher } from "./s2s-wiring.js";

// The sandbox-to-sandbox contacts, inbox and outbox as a member of the daemon's services (`services.s2s`), and what runs
// beside them while the daemon is up: the outbox's retries, and the rotation notice sent whenever the key changes.

export interface S2sSlice {
    // Contacts, the one admission, the inbox's kinds and threads, and the one outbox (s2s-service.ts).
    readonly s2s: S2s;
}

const daemonFetch = async (url: string, init: RequestInit): Promise<Response> => fetch(url, init);

export const s2sSlice = defineSlice<S2sSlice>({
    build: ({ config, authRoot, logger, whole }: Pick<CompositionCore, "config" | "authRoot" | "logger" | "whole">) => {
        const { zone } = publicAddressOf(config);
        // Every loopback, private and link-local host refused, unless the development switch lets two local daemons talk.
        const problem = (host: string): string | undefined => (config.s2sPrivateHosts ? undefined : hostProblem(host, zone));
        return {
            s2s: createS2s({
                historyRoot: config.historyRoot,
                authRoot,
                // Read through `whole` when asked: the identity and the roster are composed beside this slice.
                identity: () => whole().s2sIdentity,
                addressIo: { resolveTxt: nodeTxtResolver, fetchIdentity: identityFetcher(daemonFetch, hostUrl, problem) },
                urlOf: hostUrl,
                fetch: daemonFetch,
                hostProblem: problem,
                zone,
                roster: rosterReader(whole),
                now: Date.now,
                logger,
            }),
        };
    },
});

// The outbox looks for what is due this often; a first retry is 30 seconds after a miss.
const OUTBOX_DRAIN_MS = 15_000;

/**
 * Retries what is due, replaces the wake secret a person off the roster since held, and tells every contact of a key
 * change; answers the stop. Unref'd: it never holds the daemon up.
 */
export const startS2s = (services: Pick<Services, "s2s" | "s2sIdentity" | "logger">): (() => void) => {
    const tick = (): void => {
        void services.s2s.outbox.drain().catch((error: Error) => services.logger.warn({ err: error }, "s2s outbox drain failed"));
        void services.s2s.sweepLeavers().catch((error: Error) => services.logger.warn({ err: error }, "s2s: replacing a departed person's wake secret failed"));
    };
    const timer = setInterval(tick, OUTBOX_DRAIN_MS);
    timer.unref();
    tick();
    const unsubscribe = services.s2sIdentity.onRotated(() => {
        void services.s2s.announceRotation().catch((error: Error) => services.logger.warn({ err: error }, "s2s: telling the contacts of a new key failed"));
    });
    return () => {
        clearInterval(timer);
        unsubscribe();
    };
};
