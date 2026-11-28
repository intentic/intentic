import type { RawJsonInput } from "@intentic/sandbox-contract/protocol/raw/raw-json-routes";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import type {
    S2sAttestations,
    S2sContact,
    S2sContactTask,
    S2sContactTasks,
    S2sContactsList,
    S2sGrantsInput,
    S2sMe,
    S2sMessageSendOutcome,
    S2sOutbox,
    S2sPairingAnswer,
    S2sRecoveryMinted,
    S2sThread,
    S2sThreadsList,
    SandboxIdentity,
} from "@intentic/sandbox-contract/schemas/s2s";
import type { DropTaken } from "@intentic/sandbox-contract/schemas/account-routes";
import { hasInjectionContext, inject, type InjectionKey } from "vue";
import { sandboxBlob } from "../../client/sandbox/sandboxClient";
import { sandboxRaw } from "../../client/sandbox/sandboxRaw";
import { daemonContactPairingApi } from "../../components/contactPairing";

// THE MESSAGES TAB'S ONE SEAM to the daemon (docs/architecture/messages.md, "The editor"): every s2s route the tab
// calls, by what it does. The real one goes through `sandboxRaw` by the route's contract key, so the path, the body and
// the answer's schema come from the contract; the one file route answers bytes, read with `sandboxBlob` at the path the
// route table spells. A pairing's far half is posted on the other sandbox under the reader's session there
// (components/contactPairing.ts, shared with the link pairing and the route card). Injected through MESSAGES_API so a suite hands a composable its fake.

// What each write takes, as the route's own input schema reads it (defaults left to the daemon).
export type S2sMessageSendInput = RawJsonInput<`POST /s2s/messages`>;
export type S2sContactAddInput = RawJsonInput<`POST /s2s/contacts`>;
export type S2sContactChangeInput = RawJsonInput<`POST /s2s/contacts/{id}`>;
export type S2sPairedInput = RawJsonInput<`POST /s2s/contacts/paired`>;
export type S2sPairingRequestInput = RawJsonInput<`POST /s2s/pairings`>;
export type S2sTakeInput = RawJsonInput<`POST /s2s/messages/{id}/take`>;
export type S2sAttestationAskInput = RawJsonInput<`POST /s2s/me/attestations/ask`>;
export type S2sAttestationIssueInput = RawJsonInput<`POST /s2s/attestations/issue`>;

export interface MessagesApi {
    readonly threads: () => Promise<S2sThreadsList>;
    readonly thread: (id: string) => Promise<S2sThread>;
    readonly markRead: (id: string) => Promise<void>;
    readonly deleteThread: (id: string) => Promise<void>;
    readonly send: (message: S2sMessageSendInput) => Promise<S2sMessageSendOutcome>;
    readonly take: (message: string, take: S2sTakeInput) => Promise<DropTaken>;
    readonly file: (message: string, name: string) => Promise<Blob>;
    readonly outbox: () => Promise<S2sOutbox>;
    readonly contacts: () => Promise<S2sContactsList>;
    readonly addContact: (add: S2sContactAddInput) => Promise<S2sContact>;
    readonly changeContact: (id: string, change: S2sContactChangeInput) => Promise<S2sContact>;
    readonly removeContact: (id: string) => Promise<void>;
    readonly acceptContact: (id: string, grants: S2sGrantsInput) => Promise<S2sContact>;
    readonly blockContact: (id: string) => Promise<S2sContact>;
    readonly trustKey: (id: string, fingerprint: string) => Promise<S2sContact>;
    readonly paired: (paired: S2sPairedInput) => Promise<S2sContact>;
    /** The tasks contacts handed this sandbox, cut to the contacts the reader may use; waiting ones first. */
    readonly tasks: () => Promise<S2sContactTasks>;
    /** Allow (`approve`) or decline a contact's task that waits for the owner: the owner's or a maintainer's. */
    readonly decideTask: (contact: string, request: string, approve: boolean) => Promise<S2sContactTask>;
    /** POST /s2s/pairings on another of the reader's sandboxes, under their session there. */
    readonly pairAt: (sandboxId: string, request: S2sPairingRequestInput) => Promise<S2sPairingAnswer>;
    readonly me: () => Promise<S2sMe>;
    /** The public document alone (GET /s2s/identity), which needs no floor: what a reader below maintainer pairs with. */
    readonly identity: () => Promise<SandboxIdentity>;
    readonly addDomain: (domain: string) => Promise<S2sMe>;
    readonly removeDomain: (domain: string) => Promise<S2sMe>;
    readonly checkDomain: (domain: string) => Promise<S2sMe>;
    readonly rotate: () => Promise<S2sMe>;
    readonly mintRecovery: () => Promise<S2sRecoveryMinted>;
    readonly recover: (secret: string) => Promise<S2sMe>;
    /** What other sandboxes vouched for and this identity carries, each checked against it: a maintainer's read. */
    readonly attestations: () => Promise<S2sAttestations>;
    /** Adds the vouch a contact's `attestation.issued` message carried, once it verifies here. */
    readonly acceptAttestation: (message: string) => Promise<S2sAttestations>;
    readonly removeAttestation: (id: string) => Promise<S2sAttestations>;
    /** Asks a sandbox contact to vouch for this sandbox. */
    readonly askVouch: (ask: S2sAttestationAskInput) => Promise<S2sMessageSendOutcome>;
    /** Vouches for a sandbox contact, signed by this sandbox's key, and sends it. */
    readonly issueVouch: (issue: S2sAttestationIssueInput) => Promise<S2sMessageSendOutcome>;
}

const sandboxMessagesApi: MessagesApi = {
    threads: () => sandboxRaw(`GET /s2s/threads`),
    thread: (id) => sandboxRaw(`GET /s2s/threads/{id}`, { params: { id } }),
    markRead: async (id) => {
        await sandboxRaw(`POST /s2s/threads/{id}/read`, { params: { id } });
    },
    deleteThread: async (id) => {
        await sandboxRaw(`DELETE /s2s/threads/{id}`, { params: { id } });
    },
    send: (message) => sandboxRaw(`POST /s2s/messages`, { input: message }),
    take: (message, take) => sandboxRaw(`POST /s2s/messages/{id}/take`, { params: { id: message }, input: take }),
    file: (message, name) => sandboxBlob(rawRouteUrl(`GET /s2s/messages/{id}/files/{name}`, { id: message, name })),
    outbox: () => sandboxRaw(`GET /s2s/outbox`),
    contacts: () => sandboxRaw(`GET /s2s/contacts`),
    addContact: (add) => sandboxRaw(`POST /s2s/contacts`, { input: add }),
    changeContact: (id, change) => sandboxRaw(`POST /s2s/contacts/{id}`, { params: { id }, input: change }),
    removeContact: async (id) => {
        await sandboxRaw(`DELETE /s2s/contacts/{id}`, { params: { id } });
    },
    acceptContact: (id, grants) => sandboxRaw(`POST /s2s/contacts/{id}/accept`, { params: { id }, input: { grants } }),
    blockContact: (id) => sandboxRaw(`POST /s2s/contacts/{id}/block`, { params: { id } }),
    trustKey: (id, fingerprint) => sandboxRaw(`POST /s2s/contacts/{id}/trust-key`, { params: { id }, input: { fingerprint } }),
    tasks: () => sandboxRaw(`GET /s2s/tasks`),
    decideTask: (contact, request, approve) => sandboxRaw(`POST /s2s/contacts/{id}/tasks/{request}`, { params: { id: contact, request }, input: { approve } }),
    // Pairing's own four calls (components/contactPairing.ts), which the link pairing and the route card make too.
    ...daemonContactPairingApi,
    addDomain: (domain) => sandboxRaw(`POST /s2s/me/domains`, { input: { domain } }),
    removeDomain: (domain) => sandboxRaw(`DELETE /s2s/me/domains/{domain}`, { params: { domain } }),
    checkDomain: (domain) => sandboxRaw(`POST /s2s/me/domains/{domain}/check`, { params: { domain } }),
    rotate: () => sandboxRaw(`POST /s2s/me/rotate`),
    mintRecovery: () => sandboxRaw(`POST /s2s/me/recovery`),
    recover: (secret) => sandboxRaw(`POST /s2s/me/recover`, { input: { secret } }),
    attestations: () => sandboxRaw(`GET /s2s/me/attestations`),
    acceptAttestation: (message) => sandboxRaw(`POST /s2s/me/attestations`, { input: { message } }),
    removeAttestation: (id) => sandboxRaw(`DELETE /s2s/me/attestations/{id}`, { params: { id } }),
    askVouch: (ask) => sandboxRaw(`POST /s2s/me/attestations/ask`, { input: ask }),
    issueVouch: (issue) => sandboxRaw(`POST /s2s/attestations/issue`, { input: issue }),
};

export const MESSAGES_API: InjectionKey<MessagesApi> = Symbol.for(`intentic.messages-api`);

/** The seam an ancestor provided, or the daemon's own; outside a setup (a plain handler) always the daemon's. */
export const useMessagesApi = (): MessagesApi => (hasInjectionContext() ? inject(MESSAGES_API, sandboxMessagesApi) : sandboxMessagesApi);
