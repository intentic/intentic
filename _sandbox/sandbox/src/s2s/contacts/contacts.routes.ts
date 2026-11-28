import {
    S2sContactAcceptInputSchema,
    S2sContactAddSchema,
    S2sContactChangeSchema,
    S2sPairedSchema,
    S2sPairingRequestSchema,
    S2sTrustKeySchema,
} from "@intentic/sandbox-contract/schemas/s2s";
import type { Context } from "hono";
import { tierAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import type { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { type AskerDeps, askerOf, mayUse, type S2sAsker } from "../askers.js";
import type { S2s } from "../s2s-service.js";
import { askerDepsOf } from "../s2s-wiring.js";
import { pairIn, pairOut } from "./contact-pairing.js";
import { acceptContact, addContact, blockContact, changeContact, type ContactRefusal, isContactRefusal, removeContact, trustKey } from "./contacts.js";
import type { ContactRow } from "./contacts-store.js";

// The contacts' routes (RAW_ROUTES, schemas/s2s.ts): the list, the handshake's first half, a contact's name and grants,
// removing, accepting, blocking and trusting a new key, and both halves of an editor pairing. Who reaches each is its
// declaration's floor; past it, a person acts only on the contacts they may use (askers.ts): a sandbox-scoped one is a
// maintainer's, a person-scoped one that person's own.

const bodyOf = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T | undefined> => {
    // allow(silent-catch): a body that is not JSON reads as none, which the schema then refuses.
    const raw: unknown = await c.req.json().catch(() => undefined);
    return schema.safeParse(raw ?? {}).data;
};

const refusedWith = (c: Context<AppEnv>, refusal: ContactRefusal): Response => c.json({ error: refusal.refused }, refusal.status);

// The least a person's tier must be for a pairing they press to hand this sandbox's wake secret over (2026-11-27).
const WAKE_PAIRING_FLOOR = "collaborator";

export const contactsRoutesOf = (s2s: S2s, askers: AskerDeps) => {
    const answered = async (c: Context<AppEnv>, result: ContactRow | ContactRefusal): Promise<Response> =>
        isContactRefusal(result) ? refusedWith(c, result) : c.json(await s2s.view(result));

    // The contact the path names, when this asker may act on it; the same 404 as for none at all.
    const usable = async (c: Context<AppEnv>): Promise<{ readonly row: ContactRow; readonly asker: S2sAsker } | Response> => {
        const id = c.req.param("id") ?? "";
        const [row, asker] = await Promise.all([s2s.contacts.get(id), askerOf(askers, c)]);
        return row !== undefined && mayUse(asker, row.scope) ? { row, asker } : c.json({ error: `no contact ${id} here you may change` }, 404);
    };

    // Whether a person may hand this sandbox's wake secret to a sandbox they pair: a collaborator or above, since whoever
    // holds it can start this machine (and spend on it) at will.
    const mayWake = async (asker: S2sAsker): Promise<boolean> => {
        const tier = asker.kind === "person" ? await askers.tierOf(asker.email) : undefined;
        return tier !== undefined && tierAtLeast(tier, WAKE_PAIRING_FLOOR);
    };

    const onContact =
        (act: (row: ContactRow, c: Context<AppEnv>) => Promise<ContactRow | ContactRefusal | Response>) =>
        async (c: Context<AppEnv>): Promise<Response> => {
            const found = await usable(c);
            if (found instanceof Response) {
                return found;
            }
            const result = await act(found.row, c);
            return result instanceof Response ? result : answered(c, result);
        };

    const withBody =
        <T>(schema: z.ZodType<T>, expected: string, act: (row: ContactRow, input: T) => Promise<ContactRow | ContactRefusal>) =>
        async (row: ContactRow, c: Context<AppEnv>): Promise<ContactRow | ContactRefusal | Response> => {
            const input = await bodyOf(c, schema);
            return input === undefined ? c.json({ error: expected }, 400) : act(row, input);
        };

    return {
        "GET /s2s/contacts": async (c: Context<AppEnv>) => {
            const asker = await askerOf(askers, c);
            const rows = (await s2s.contacts.list()).filter((row) => mayUse(asker, row.scope));
            return c.json({ contacts: await Promise.all(rows.toSorted((a, b) => b.updatedAt - a.updatedAt).map(s2s.view)) });
        },
        "POST /s2s/contacts": async (c: Context<AppEnv>) => {
            const input = await bodyOf(c, S2sContactAddSchema);
            return input === undefined ? c.json({ error: "name the sandbox to add: {address, note?, grants?}" }, 400) : answered(c, await addContact(s2s.core, input));
        },
        "POST /s2s/contacts/{id}": onContact(withBody(S2sContactChangeSchema, "a change names a name or grants: {name?, grants?}", (row, input) => changeContact(s2s.core, row.id, input))),
        "DELETE /s2s/contacts/{id}": async (c: Context<AppEnv>) => {
            const found = await usable(c);
            if (found instanceof Response) {
                return found;
            }
            const removed = await removeContact(s2s.core, found.row.id);
            return isContactRefusal(removed) ? refusedWith(c, removed) : c.json({ ok: true as const });
        },
        "POST /s2s/contacts/{id}/accept": onContact(withBody(S2sContactAcceptInputSchema, "accept with the grants it is given: {grants?}", (row, input) => acceptContact(s2s.core, row.id, input.grants))),
        "POST /s2s/contacts/{id}/block": onContact(async (row) => blockContact(s2s.core, row.id)),
        "POST /s2s/contacts/{id}/trust-key": onContact(withBody(S2sTrustKeySchema, "name the fingerprint you compared: {fingerprint}", (row, input) => trustKey(s2s.core, row.id, input.fingerprint))),
        "POST /s2s/pairings": async (c: Context<AppEnv>) => {
            const input = await bodyOf(c, S2sPairingRequestSchema);
            if (input === undefined) {
                return c.json({ error: "a pairing carries the other sandbox's document, the scope and the grants" }, 400);
            }
            const asker = await askerOf(askers, c);
            const answer = await pairIn(s2s.core, input, asker, await mayWake(asker));
            return isContactRefusal(answer) ? refusedWith(c, answer) : c.json(answer);
        },
        "POST /s2s/contacts/paired": async (c: Context<AppEnv>) => {
            const input = await bodyOf(c, S2sPairedSchema);
            if (input === undefined) {
                return c.json({ error: "hand back the other sandbox's pairing answer, the scope and the grants" }, 400);
            }
            const asker = await askerOf(askers, c);
            return answered(c, await pairOut(s2s.core, input, asker, await mayWake(asker)));
        },
    };
};

export const s2sContactsRawRoutes = defineRawRoutes((services: Pick<Services, "s2s" | "agents" | "ownerEmail" | "members">) =>
    contactsRoutesOf(services.s2s, askerDepsOf(services)),
);
