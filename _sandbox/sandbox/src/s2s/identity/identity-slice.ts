import { join } from "node:path";
import { normalizeAddress } from "@intentic/sandbox-contract/s2s";
import type { CompositionCore, Services } from "../../composition.js";
import { type Config, publicAddressOf } from "../../env.config.js";
import { defineSlice } from "../../seams/slice.js";
import { identityAttestationsDocument } from "./identity-attestations.js";
import { identityDomainsDocument, nodeTxtResolver } from "./identity-domains.js";
import { sandboxIdentityDocument } from "./identity-keys.js";
import { createS2sIdentity, type IdentitySelf, type S2sIdentity } from "./s2s-identity.js";

// The sandbox-to-sandbox identity as a member of the daemon's services (`services.s2sIdentity`), and its daily check of
// the own domains' TXT records.

export interface S2sIdentitySlice {
    // This sandbox's key set, signed document, own domains, rotation and recovery (s2s-identity.ts).
    readonly s2sIdentity: S2sIdentity;
}

// Who this sandbox is: its id from the connect token, its host from its public URL (else `<id>.<zone>`, else the loopback
// listener a local daemon answers on), and its name.
const identitySelfOf = (config: Pick<Config, "zone" | "sandbox" | "connectToken" | "local">, name: string | undefined): IdentitySelf => {
    const { zone, sandboxId } = publicAddressOf(config);
    const fromZone = sandboxId === undefined || zone === undefined ? undefined : `${sandboxId}.${zone}`;
    const host = normalizeAddress(config.sandbox.publicUrl) ?? fromZone ?? `localhost:${config.local.port}`;
    const sandbox = sandboxId ?? "local";
    return { sandbox, name: name ?? sandbox, host };
};

export const s2sIdentitySlice = defineSlice<S2sIdentitySlice>({
    build: ({ config, authRoot, logger, whole }: Pick<CompositionCore, "config" | "authRoot" | "logger" | "whole">) => ({
        s2sIdentity: createS2sIdentity({
            keysPath: join(authRoot, sandboxIdentityDocument.path),
            domainsPath: join(config.historyRoot, identityDomainsDocument.path),
            attestationsPath: join(config.historyRoot, identityAttestationsDocument.path),
            // Read through `whole` when asked: the sandbox's info is composed beside this slice.
            self: () => identitySelfOf(config, whole().info?.name),
            resolveTxt: nodeTxtResolver,
            now: Date.now,
            warn: (message, error) => logger.warn({ err: error }, message),
        }),
    }),
});

const DOMAIN_CHECK_MS = 24 * 60 * 60 * 1000;

// Every claimed domain checked at boot and then daily, so a record taken down drops the domain from the document.
export const startIdentityDomainChecks = (services: Pick<Services, "s2sIdentity" | "logger">): (() => void) => {
    const tick = (): void => {
        void services.s2sIdentity.checkDomains().catch((error: Error) => services.logger.warn({ err: error }, "s2s identity: checking the own domains failed"));
    };
    const timer = setInterval(tick, DOMAIN_CHECK_MS);
    timer.unref();
    tick();
    return () => clearInterval(timer);
};
