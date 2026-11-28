import { join } from "node:path";
import { keyedLock } from "@intentic/base/async";
import { type AddressIo, type RandomBytes, resolveAddress } from "@intentic/sandbox-contract/s2s";
import type { S2sContact, S2sEnvelope, S2sInboxAccepted, S2sRefusal } from "@intentic/sandbox-contract/schemas/s2s";
import type { Logger } from "pino";
import type { Caller } from "../auth/auth.js";
import { opt } from "../opt.js";
import { createAdmission, refusalStatus, type S2sAdmission } from "./admission.js";
import { registerAttestationKinds } from "./attestations/attestation-kinds.js";
import { type CallClient, createCallClient } from "./calls/call-client.js";
import { type CallDoor, createCallDoor } from "./calls/call-door.js";
import { registerContactKinds } from "./contacts/contact-kinds.js";
import { contactView } from "./contacts/contact-view.js";
import { type ContactsCore, createContactsCore, keyChangesOf } from "./contacts/contacts.js";
import { type ContactRow, type ContactsStore, fileContactsStore, s2sContactsDocument } from "./contacts/contacts-store.js";
import { fileWakeSecrets, s2sSecretsDocument, type WakeSecrets } from "./contacts/s2s-secrets.js";
import type { S2sHeard, S2sHearing } from "./heard.js";
import type { S2sIdentity } from "./identity/s2s-identity.js";
import { createS2sKinds, type S2sKinds } from "./messages/kinds.js";
import { registerMessageKinds } from "./messages/message-kinds.js";
import { createS2sOutbox, type S2sFetch, type S2sOutbox } from "./messages/outbox.js";
import { deliveryOf } from "./messages/send-message.js";
import { fileThreadsStore, type ThreadsStore } from "./messages/threads-store.js";
import { fileSeenIds, s2sSeenIdsDocument, type SeenIds } from "./seen-ids.js";

// THE SANDBOX-TO-SANDBOX SERVICE (docs/architecture/messages.md): the contacts, the one admission, the inbox's kinds and
// threads, and the one outbox, composed over this sandbox's identity. Built from plain dependencies so two of them can
// talk over HTTP in a test exactly as two daemons do (s2s-slice.ts wires the daemon's own). The seams later modules plug
// into: `kinds.register` (a kind's handler), `admission` (its checks), `contacts` and `core` (the contact rows and what a
// person does to them), `outbox.enqueue` (anything sent), `threads` (what the inbox shows), `onHeard` (what automations
// hear), and `calls` (records and operating: the door's methods are served from above, `calls.door.serve`).

export interface S2sDeps {
    readonly historyRoot: string;
    readonly authRoot: string;
    readonly identity: () => S2sIdentity;
    // DNS TXT and GET https://<host>/s2s/identity, as resolveAddress takes them.
    readonly addressIo: AddressIo;
    // The base URL a sandbox host answers on: https, or http for a loopback daemon.
    readonly urlOf: (host: string) => string;
    readonly fetch: S2sFetch;
    // Why a host is no address to fetch from or post to (s2s-wiring.ts hostProblem), or undefined; the daemon's own refuses
    // every loopback, private and link-local one unless the private-hosts switch is on, as a suite's two local daemons have it.
    readonly hostProblem: (host: string) => string | undefined;
    // The platform's zone, under which a sandbox's own host vouches for its id (contacts-store.ts vouchedSandboxOf).
    readonly zone?: string | undefined;
    readonly roster: () => Promise<{ readonly callerOf: (email: string) => Caller | undefined }>;
    readonly now: () => number;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly random?: RandomBytes;
}

// What the inbox door answers: taken (with what runs once the sender has its answer), or refused.
export type InboxAnswer =
    | { readonly status: 200 | 202; readonly body: S2sInboxAccepted; readonly after?: () => Promise<void> }
    | { readonly status: ReturnType<typeof refusalStatus>; readonly body: S2sRefusal };

export interface S2s {
    readonly contacts: ContactsStore;
    readonly secrets: WakeSecrets;
    readonly threads: ThreadsStore;
    readonly outbox: S2sOutbox;
    readonly kinds: S2sKinds;
    readonly admission: S2sAdmission;
    readonly seen: SeenIds;
    // Calls between contacts (calls/): this sandbox's door, and its sessions to the contacts it calls.
    readonly calls: S2sCalls;
    // What a person does to a contact (contacts/contacts.ts, contacts/contact-pairing.ts take it).
    readonly core: ContactsCore;
    // One envelope at POST /s2s/inbox, admitted, stored and answered.
    readonly receive: (envelope: S2sEnvelope) => Promise<InboxAnswer>;
    // A thread read by a person: its received messages marked read, and the contact told of the newest.
    readonly read: (thread: string) => Promise<void>;
    readonly view: (row: ContactRow) => Promise<S2sContact>;
    // Every event automations may hear; answers the unsubscribe.
    readonly onHeard: (listener: S2sHearing) => () => void;
    // Tells automations of an event a kind registered outside this module stored.
    readonly hear: S2sHearing;
    // Tells every contact this sandbox's key changed (`identity.rotated`), and ends every call session either way.
    readonly announceRotation: () => Promise<void>;
    // The inbound wake secret, while a contact holds it: what the edge's wake door for /s2s/inbox is registered with.
    readonly wakeSecret: () => Promise<string | undefined>;
    // Replaces the wake secret when a person-scoped contact handed it has left the roster since (run with the outbox's drain).
    readonly sweepLeavers: () => Promise<void>;
}

export interface S2sCalls {
    readonly door: CallDoor;
    readonly client: CallClient;
}

// The kinds a person sends that their thread lists, each with its delivery.
const THREADED_KINDS: ReadonlySet<string> = new Set(["message", "attestation.request", "attestation.issued"]);

const hearingFor = (logger: S2sDeps["logger"]) => {
    const listeners = new Set<S2sHearing>();
    const heard = async (event: S2sHeard): Promise<void> => {
        for (const listener of listeners) {
            await listener(event).catch((error: Error) => logger.warn({ err: error, event: event.event }, "s2s: an automation could not hear an event"));
        }
    };
    const onHeard = (listener: S2sHearing): (() => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    };
    return { heard, onHeard };
};

export const createS2s = (deps: S2sDeps): S2s => {
    const contacts = fileContactsStore(join(deps.historyRoot, s2sContactsDocument.path));
    const secrets = fileWakeSecrets(join(deps.authRoot, s2sSecretsDocument.path), deps.now);
    const threads = fileThreadsStore(deps.historyRoot);
    const seen = fileSeenIds(join(deps.historyRoot, s2sSeenIdsDocument.path), deps.now);
    const outbox = createS2sOutbox({ ...deps, contacts, secrets });
    const resolve = (address: string) => resolveAddress(address, deps.addressIo);
    const core = createContactsCore({
        store: contacts,
        secrets,
        outbox,
        identity: deps.identity,
        resolve,
        now: deps.now,
        logger: deps.logger,
        zone: deps.zone,
        roster: deps.roster,
    });
    const kinds = createS2sKinds();
    const admission = createAdmission({ identity: deps.identity, contacts, seen, resolve, roster: deps.roster, kinds, keys: keyChangesOf(core), now: deps.now, hostProblem: deps.hostProblem });
    const { heard, onHeard } = hearingFor(deps.logger);
    const calls: S2sCalls = {
        door: createCallDoor({ identity: deps.identity, admission, contacts, roster: deps.roster, now: deps.now, logger: deps.logger, ...opt("random", deps.random) }),
        client: createCallClient({ identity: deps.identity, urlOf: deps.urlOf, fetch: deps.fetch, hostProblem: deps.hostProblem, now: deps.now, ...opt("random", deps.random) }),
    };
    registerContactKinds(core, kinds, heard);
    registerMessageKinds(threads, kinds, heard);
    registerAttestationKinds(threads, kinds, deps.identity);
    // A sent message's delivery, or an attestation's asked for or sent, as its thread shows it.
    outbox.onSettled(async (entry, settled) => {
        const thread = THREADED_KINDS.has(entry.payload.kind) && entry.thread !== undefined ? await threads.byWire(entry.contact, entry.thread) : undefined;
        if (thread !== undefined) {
            await threads.changeMessage(thread.id, entry.id, (held) => ({ ...held, delivery: deliveryOf(settled) }));
        }
    });
    return {
        contacts,
        secrets,
        threads,
        outbox,
        kinds,
        admission,
        seen,
        calls,
        core,
        receive: receiverOf({ admission, kinds, seen, contacts, logger: deps.logger }),
        read: async (thread) => {
            const newest = await threads.markRead(thread);
            const held = await threads.get(thread);
            const row = held === undefined ? undefined : await contacts.get(held.contact);
            if (newest !== undefined && row?.state === "accepted") {
                await outbox.enqueue({ contact: row, payload: { kind: "receipt", of: newest.id, read: true, at: deps.now() }, thread: held?.wire });
            }
        },
        view: async (row) => contactView(row, (await secrets.theirs(row.id)) !== undefined),
        onHeard,
        hear: heard,
        announceRotation: async () => {
            // A session opened under the old key ends with it, on both sides: the far side opens a new one.
            calls.door.forget();
            calls.client.rotated();
            const document = await deps.identity().document();
            for (const row of await contacts.list()) {
                if (row.state !== "blocked") {
                    await outbox.enqueue({ contact: row, payload: { kind: "identity.rotated", document } });
                }
            }
        },
        wakeSecret: async () => ((await contacts.list()).some((row) => row.state === "accepted" && row.grants.wake) ? secrets.inbound() : undefined),
        sweepLeavers: core.sweepLeavers,
    };
};

interface ReceiverDeps {
    readonly admission: S2sAdmission;
    readonly kinds: S2sKinds;
    readonly seen: SeenIds;
    readonly contacts: ContactsStore;
    readonly logger: S2sDeps["logger"];
}

// The inbox door's work for one envelope, one at a time per envelope id, so a retry racing its own first try lands once.
const receiverOf = (deps: ReceiverDeps): S2s["receive"] => {
    const serialize = keyedLock<string>();
    const refused = (code: S2sRefusal["code"], error: string): InboxAnswer => ({ status: refusalStatus(code), body: { error, code } });
    return async (envelope) =>
        serialize(envelope.id, async () => {
            const admitted = await deps.admission.admit(envelope);
            switch (admitted.kind) {
                case "duplicate":
                    return { status: 200, body: { ok: true, id: admitted.id, duplicate: true } };
                case "swallowed":
                    return { status: 202, body: { ok: true, id: admitted.id } };
                case "refused":
                    return refused(admitted.code, admitted.error);
            }
            const { received } = admitted;
            const handler = deps.kinds.handlerOf(received.payload.kind);
            const outcome = handler === undefined ? { refused: "unready" as const, error: "no handler" } : await handler(received);
            if ("refused" in outcome) {
                return refused(outcome.refused, outcome.error);
            }
            await deps.seen.add(envelope.id);
            if (received.contact !== undefined) {
                await deps.contacts.change(received.contact.id, (held) => ({ ...held, lastSeenAt: received.receivedAt }));
            }
            const { after } = outcome;
            if (after === undefined) {
                return { status: 202, body: { ok: true, id: envelope.id } };
            }
            // What runs after the answer never rejects: a failure in it is logged, the envelope is already taken.
            const handOn = async (): Promise<void> =>
                after().catch((error: Error) => deps.logger.warn({ err: error, id: envelope.id, kind: received.payload.kind }, "s2s: handing a received envelope on failed"));
            return { status: 202, body: { ok: true, id: envelope.id }, after: handOn };
        });
};
