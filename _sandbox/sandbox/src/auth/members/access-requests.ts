import { join } from "node:path";
import { type AccessAsk, type AccessRequest, AccessWantSchema } from "@intentic/sandbox-contract/schemas/members";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

/* What people with access to this sandbox have asked its owner for (POST /members/requests): one open request per person,
 * keyed by their lowercased email, a later ask replacing theirs. The owner reads them beside the roster, and granting the
 * person anything answers theirs (members.routes.ts), as removing them does. Under the history root beside the roster
 * itself, where no workspace write reaches: a request is the person's word, not something a turn may plant. */

const StoredRequestSchema = z.object({ want: AccessWantSchema, place: z.string(), at: z.number() });
const RequestsSchema = z.object({ requests: z.record(z.string(), StoredRequestSchema) });
type Requests = z.infer<typeof RequestsSchema>;

export const accessRequestsDocument = defineDocument({
    root: "history",
    path: "identity/access-requests.json",
    // Asks made of this sandbox's owner by its own roster, which does not travel either.
    portability: "identity",
    note: "People ask for access again from where they were refused.",
    schema: RequestsSchema,
});

// The oldest kept: a roster is a handful of people, each with one request at most.
const REQUESTS_KEPT = 200;

export interface AccessRequestsStore {
    /** Every open request, newest first. */
    readonly list: () => Promise<AccessRequest[]>;
    /** This person's open request, if they have one. */
    readonly of: (email: string) => Promise<AccessRequest | undefined>;
    /** Records this person's ask, replacing any they made before. */
    readonly ask: (email: string, ask: AccessAsk, at: number) => Promise<void>;
    /** Takes this person's request away: answered by a grant, or dismissed by the owner. */
    readonly settle: (email: string) => Promise<void>;
}

const listed = (requests: Requests): AccessRequest[] =>
    Object.entries(requests.requests)
        .map(([email, request]) => ({ email, ...request }))
        .sort((left, right) => right.at - left.at);

export const fileAccessRequests = (historyRoot: string): AccessRequestsStore => {
    // Every handle on one path shares its write queue (queueOnFile), so a handle per call is enough.
    const file = () =>
        openDocument(accessRequestsDocument, join(historyRoot, accessRequestsDocument.path), { fallback: (): Requests => ({ requests: {} }) });
    return {
        list: async () => listed(await file().read()),
        of: async (email) => listed(await file().read()).find((request) => request.email === email.toLowerCase()),
        ask: async (email, { want, place }, at) => {
            await file().update((current) => {
                const requests = { ...current.requests, [email.toLowerCase()]: { want, place, at } };
                const kept = Object.entries(requests)
                    .sort(([, left], [, right]) => right.at - left.at)
                    .slice(0, REQUESTS_KEPT);
                return { requests: Object.fromEntries(kept) };
            });
        },
        settle: async (email) => {
            await file().update((current) => ({
                requests: Object.fromEntries(Object.entries(current.requests).filter(([held]) => held !== email.toLowerCase())),
            }));
        },
    };
};
