import { normalizeDomain } from "@intentic/sandbox-contract/s2s";
import { S2sDomainInputSchema, type S2sAttestations, type S2sMe, S2sRecoverInputSchema } from "@intentic/sandbox-contract/schemas/s2s";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { type IdentityRefusal, isIdentityRefusal, type S2sIdentity } from "./s2s-identity.js";

// The identity's routes (RAW_ROUTES, schemas/s2s.ts): the public document every other daemon fetches, with no
// credential, and the Identity section's own: its view, own domains and their checks, rotation, the recovery key, and the
// attestations it carries (listed and removed here; added from a contact's message by s2s/attestations/).
// Who may call each is the route's declaration; nothing here checks a tier again.

const answered = (c: Context<AppEnv>, result: S2sMe | S2sAttestations | IdentityRefusal): Response =>
    isIdentityRefusal(result) ? c.json({ error: result.refused }, result.status) : c.json(result);

const bodyOf = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T | undefined> => {
    // allow(silent-catch): a body that is not JSON reads as none, which the schema then refuses.
    const raw: unknown = await c.req.json().catch(() => undefined);
    return schema.safeParse(raw ?? {}).data;
};

// The domain a path names, in the spelling it was claimed under.
const domainParam = (c: Context<AppEnv>): string => {
    const raw = c.req.param("domain") ?? "";
    return normalizeDomain(raw) ?? raw;
};

export const identityRoutesOf = (identity: S2sIdentity) => ({
    "GET /s2s/identity": async (c: Context<AppEnv>) => c.json(await identity.document()),
    "GET /s2s/me": async (c: Context<AppEnv>) => c.json(await identity.me()),
    "POST /s2s/me/domains": async (c: Context<AppEnv>) => {
        const input = await bodyOf(c, S2sDomainInputSchema);
        return input === undefined ? c.json({ error: "name the domain to claim" }, 400) : answered(c, await identity.claimDomain(input.domain));
    },
    "DELETE /s2s/me/domains/{domain}": async (c: Context<AppEnv>) => answered(c, await identity.removeDomain(domainParam(c))),
    "POST /s2s/me/domains/{domain}/check": async (c: Context<AppEnv>) => answered(c, await identity.checkDomain(domainParam(c))),
    "POST /s2s/me/rotate": async (c: Context<AppEnv>) => c.json(await identity.rotate()),
    "POST /s2s/me/recovery": async (c: Context<AppEnv>) => c.json(await identity.mintRecovery()),
    "POST /s2s/me/recover": async (c: Context<AppEnv>) => {
        const input = await bodyOf(c, S2sRecoverInputSchema);
        return input === undefined ? c.json({ error: "paste the recovery key" }, 400) : answered(c, await identity.recover(input.secret));
    },
    "GET /s2s/me/attestations": async (c: Context<AppEnv>) => c.json(await identity.attestations()),
    "DELETE /s2s/me/attestations/{id}": async (c: Context<AppEnv>) => answered(c, await identity.removeAttestation(c.req.param("id") ?? "")),
});

export const s2sIdentityRawRoutes = defineRawRoutes((services: Pick<Services, "s2sIdentity">) => identityRoutesOf(services.s2sIdentity));
