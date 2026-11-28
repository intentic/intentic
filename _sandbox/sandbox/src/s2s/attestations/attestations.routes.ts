import { S2sAttestationAcceptSchema, S2sAttestationAskSchema, S2sAttestationIssueSchema } from "@intentic/sandbox-contract/schemas/s2s";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { isIdentityRefusal, type S2sIdentity } from "../identity/s2s-identity.js";
import type { S2s } from "../s2s-service.js";
import { acceptVouch, type AttestationDeps, askForVouch, vouchForContact } from "./attestations.js";

// The attestations' routes (RAW_ROUTES, schemas/s2s.ts) that reach a contact: adding the vouch a contact sent to this
// identity, asking a contact for one, and vouching for one. The owner's or a maintainer's, by the routes' declaration;
// nothing here checks a tier again. Listing and removing what the identity carries are the identity's own routes.

const bodyOf = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<z.ZodSafeParseResult<T>> => {
    // allow(silent-catch): a body that is not JSON reads as none, which the schema then refuses.
    const raw: unknown = await c.req.json().catch(() => undefined);
    return schema.safeParse(raw ?? {});
};

// The schema's first complaint, in its own words.
const problemOf = (error: z.ZodError): string => {
    const issue = error.issues[0];
    return issue === undefined ? "the request does not read" : `${issue.path.join(".") || "the request"}: ${issue.message}`;
};

export const attestationsRoutesOf = (s2s: S2s, identity: () => S2sIdentity) => {
    const deps: AttestationDeps = { contacts: s2s.contacts, threads: s2s.threads, outbox: s2s.outbox, identity, now: Date.now };
    return {
        "POST /s2s/me/attestations": async (c: Context<AppEnv>) => {
            const input = await bodyOf(c, S2sAttestationAcceptSchema);
            if (!input.success) {
                return c.json({ error: "name the message that carried the attestation" }, 400);
            }
            const added = await acceptVouch(deps, input.data);
            return isIdentityRefusal(added) ? c.json({ error: added.refused }, added.status) : c.json(added);
        },
        "POST /s2s/me/attestations/ask": async (c: Context<AppEnv>) => {
            const input = await bodyOf(c, S2sAttestationAskSchema);
            if (!input.success) {
                return c.json({ error: problemOf(input.error) }, 400);
            }
            const sent = await askForVouch(deps, input.data);
            return "error" in sent ? c.json({ error: sent.error }, sent.status) : c.json(sent);
        },
        "POST /s2s/attestations/issue": async (c: Context<AppEnv>) => {
            const input = await bodyOf(c, S2sAttestationIssueSchema);
            if (!input.success) {
                return c.json({ error: problemOf(input.error) }, 400);
            }
            const sent = await vouchForContact(deps, input.data);
            return "error" in sent ? c.json({ error: sent.error }, sent.status) : c.json(sent);
        },
    };
};

export const s2sAttestationsRawRoutes = defineRawRoutes((services: Pick<Services, "s2s" | "s2sIdentity">) => attestationsRoutesOf(services.s2s, () => services.s2sIdentity));
