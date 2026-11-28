import { type RawRoutes, refuse } from "@intentic/contract-serve";
import {
    S2sContactAcceptInputSchema,
    S2sContactAddSchema,
    S2sContactChangeSchema,
    S2sContactTaskDecisionSchema,
    S2sDomainInputSchema,
    S2sMessageSendSchema,
    S2sPairedSchema,
    S2sPairingRequestSchema,
    S2sRecoverInputSchema,
    S2sTakeSchema,
    S2sTrustKeySchema,
} from "@intentic/sandbox-contract/schemas/s2s";
import { json } from "../../transport";
import { acceptContact, addContact, blockContact, changeContact, contactsList, pairHere, paired, removeContact, trustKey } from "./s2sContacts";
import { checkDomain, claimDomain, dropDomain, identityDocument, meAt, mintRecovery, recover, rotate } from "./s2sIdentity";
import { contactTasks, decideTask } from "./s2sTasks";
import { deleteThread, fileOf, markRead, outbox, send, take, threadOf, threadsList } from "./s2sThreads";

// Contacts and messages (docs/architecture/messages.md), the editor's side of them: this sandbox's identity and its
// domains, its contacts and the pairing between two of the owner's sandboxes, the tasks contacts handed it and the owner's
// Allow or Decline for one that waits, its threads, their files and the outbox,
// each against the store of the sandbox the call was sent to. Bodies are parsed here, as the daemon's routes parse them,
// and refused whole. Spread into daemon/raw.ts's table.

type Parsed<T> = { readonly success: true; readonly data: T } | { readonly success: false; readonly error: { readonly message: string } };
const accepted = <T>(parsed: Parsed<T>): T => (parsed.success ? parsed.data : refuse(parsed.error.message, 400));

export const s2sRoutes = {
    "GET /s2s/identity": ({ url }) => json(identityDocument(url)),
    "GET /s2s/me": ({ url }) => json(meAt(url)),
    "POST /s2s/me/domains": async ({ request, url }) => json(claimDomain(url, accepted(S2sDomainInputSchema.safeParse(await request.json())).domain)),
    "DELETE /s2s/me/domains/{domain}": ({ url, param }) => json(dropDomain(url, param(`domain`))),
    "POST /s2s/me/domains/{domain}/check": ({ url, param }) => json(checkDomain(url, param(`domain`))),
    "POST /s2s/me/rotate": ({ url }) => json(rotate(url)),
    "POST /s2s/me/recovery": ({ url }) => json(mintRecovery(url)),
    "POST /s2s/me/recover": async ({ request, url }) => json(recover(url, accepted(S2sRecoverInputSchema.safeParse(await request.json())).secret)),
    "GET /s2s/contacts": ({ url }) => json(contactsList(url)),
    "POST /s2s/contacts/paired": async ({ request, url }) => json(paired(url, accepted(S2sPairedSchema.safeParse(await request.json())))),
    "POST /s2s/contacts": async ({ request, url }) => json(addContact(url, accepted(S2sContactAddSchema.safeParse(await request.json())))),
    "POST /s2s/contacts/{id}": async ({ request, url, param }) => json(changeContact(url, param(`id`), accepted(S2sContactChangeSchema.safeParse(await request.json())))),
    "DELETE /s2s/contacts/{id}": ({ url, param }) => json(removeContact(url, param(`id`))),
    "POST /s2s/contacts/{id}/accept": async ({ request, url, param }) =>
        json(acceptContact(url, param(`id`), accepted(S2sContactAcceptInputSchema.safeParse(await request.json())).grants)),
    "POST /s2s/contacts/{id}/block": ({ url, param }) => json(blockContact(url, param(`id`))),
    "POST /s2s/contacts/{id}/trust-key": async ({ request, url, param }) =>
        json(trustKey(url, param(`id`), accepted(S2sTrustKeySchema.safeParse(await request.json())).fingerprint)),
    "GET /s2s/tasks": ({ url }) => json(contactTasks(url)),
    "POST /s2s/contacts/{id}/tasks/{request}": async ({ request, url, param }) =>
        json(decideTask(url, param(`id`), param(`request`), accepted(S2sContactTaskDecisionSchema.safeParse(await request.json())).approve)),
    "GET /s2s/outbox": () => json(outbox()),
    "POST /s2s/pairings": async ({ request, url }) => json(pairHere(url, accepted(S2sPairingRequestSchema.safeParse(await request.json())))),
    "GET /s2s/threads": () => json(threadsList()),
    "GET /s2s/threads/{id}": ({ param }) => json(threadOf(param(`id`))),
    "DELETE /s2s/threads/{id}": ({ param }) => json(deleteThread(param(`id`))),
    "POST /s2s/threads/{id}/read": ({ param }) => json(markRead(param(`id`))),
    "POST /s2s/messages": async ({ request }) => json(send(accepted(S2sMessageSendSchema.safeParse(await request.json())))),
    "GET /s2s/messages/{id}/files/{name}": ({ param }) => fileOf(param(`id`), param(`name`)),
    "POST /s2s/messages/{id}/take": async ({ request, param }) => json(take(param(`id`), accepted(S2sTakeSchema.safeParse(await request.json())))),
} satisfies RawRoutes;
