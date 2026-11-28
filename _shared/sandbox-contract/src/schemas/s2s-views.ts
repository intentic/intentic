import { z } from "zod";
import { DropTakeSchema, DropTakenSchema } from "./account-routes.js";
import {
    S2sAddressSchema,
    S2sAttestationSchema,
    S2sClaimsSchema,
    S2sContactNoticeSchema,
    S2sContactOriginSchema,
    S2sContactScopeSchema,
    S2sContactStateSchema,
    S2sDomainSchema,
    S2sFingerprintSchema,
    S2sGrantsSchema,
    S2sGrantsUpdateSchema,
    S2sPersonSchema,
    S2S_NOTE_MAX,
    S2sRecoveryFingerprintSchema,
    S2sRefSchema,
    SandboxIdentitySchema,
} from "./s2s-identity.js";
import { S2S_MESSAGE_FILES_MAX, S2S_MESSAGE_TEXT_MAX, S2S_SUBJECT_MAX, S2sAttachmentSchema, S2sEnvelopeIdSchema, S2sPayloadKindSchema } from "./s2s-wire.js";

// SANDBOX-TO-SANDBOX (docs/architecture/messages.md), what the editor and the `messages` command read and send: the
// Messages tab's contacts, threads, outbox and identity, and the pairing and upgrade exchanges.
// Re-exported from schemas/s2s.ts.

/* CONTACTS, as the Contacts section lists them. */

const contactId = S2sRefSchema.describe("The contact's id here.");

export const S2sContactSchema = z.object({
    id: contactId,
    address: S2sAddressSchema.describe("What it is addressed by: its host or an own domain."),
    name: z.string().max(120).describe("Its display name, from its document unless a person renamed it here."),
    host: S2sAddressSchema.describe("Its current host, from the last verified document."),
    domains: z.array(S2sDomainSchema).describe("The own domains its last verified document lists."),
    fingerprint: S2sFingerprintSchema.describe("The key pinned for it."),
    recovery: S2sRecoveryFingerprintSchema.optional().describe("Its recovery key's fingerprint, pinned with it."),
    scope: S2sContactScopeSchema,
    state: S2sContactStateSchema,
    grants: S2sGrantsSchema.describe("What this sandbox lets it do here."),
    theirGrants: S2sGrantsSchema.optional().describe("What it said it lets this sandbox do there; informational."),
    holdsWake: z.boolean().describe("This sandbox holds its wake secret, so messages to it wake it."),
    notices: z.array(S2sContactNoticeSchema),
    origin: S2sContactOriginSchema,
    note: z.string().max(S2S_NOTE_MAX).optional().describe("What its request said, for one waiting on a person here."),
    pendingKey: S2sFingerprintSchema.optional().describe("A key-changed contact's new fingerprint, which Trust new key pins."),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    lastSeenAt: z.number().int().optional().describe("When something last arrived from it."),
});
export type S2sContact = z.infer<typeof S2sContactSchema>;
export const S2sContactsListSchema = z.object({ contacts: z.array(S2sContactSchema) });
export type S2sContactsList = z.infer<typeof S2sContactsListSchema>;

// POST /s2s/contacts: the handshake, sandbox-scoped. The address is resolved, its key pinned provisionally and a request sent.
export const S2sContactAddSchema = z.object({
    address: z.string().trim().min(1).max(300).describe("A sandbox host or an own domain, as a person typed it."),
    note: z.string().max(S2S_NOTE_MAX).optional(),
    grants: S2sGrantsSchema.prefault({}).describe("What this sandbox offers it."),
});
export type S2sContactAdd = z.infer<typeof S2sContactAddSchema>;
// POST /s2s/contacts/{id}: a name of this sandbox's own for it, and changed grants (sent on as `contact.update`).
export const S2sContactChangeSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    grants: S2sGrantsUpdateSchema.optional(),
});
export type S2sContactChange = z.infer<typeof S2sContactChangeSchema>;
// POST /s2s/contacts/{id}/accept: the grants it is accepted with; absent, messages only.
export const S2sContactAcceptInputSchema = z.object({ grants: S2sGrantsSchema.prefault({}) });
export type S2sContactAcceptInput = z.infer<typeof S2sContactAcceptInputSchema>;
// POST /s2s/contacts/{id}/trust-key: the fingerprint the person compared, which must be the one waiting.
export const S2sTrustKeySchema = z.object({ fingerprint: S2sFingerprintSchema });
export type S2sTrustKey = z.infer<typeof S2sTrustKeySchema>;

/* PAIRING, one person signed in to both sandboxes: the editor carries each side's document to the other. */

// POST /s2s/pairings, on the sandbox being paired with, under the person's session there.
export const S2sPairingRequestSchema = z.object({
    document: SandboxIdentitySchema.describe("The other sandbox's document, as the editor read it there (GET /s2s/me)."),
    scope: z.enum(["sandbox", "person"]).describe("The sandbox as itself (a maintainer's press), or the signed-in person's own route."),
    grants: S2sGrantsSchema.prefault({}).describe("What this sandbox lets the other one do here."),
    theirGrants: S2sGrantsSchema.optional().describe("What the other sandbox will let this one do there; informational."),
    wake: z.string().min(32).max(200).optional().describe("The other sandbox's wake secret, when it grants this one `wake`."),
});
export type S2sPairingRequest = z.infer<typeof S2sPairingRequestSchema>;
export const S2sPairingAnswerSchema = z.object({
    contact: contactId.describe("The contact it filed, there."),
    document: SandboxIdentitySchema.describe("Its own document."),
    grants: S2sGrantsSchema.describe("What it lets the other sandbox do there."),
    wake: z.string().min(32).max(200).optional().describe("Its wake secret, when it granted `wake`."),
});
export type S2sPairingAnswer = z.infer<typeof S2sPairingAnswerSchema>;
// POST /s2s/contacts/paired, back on the first sandbox: the answer, and what this one grants the other.
export const S2sPairedSchema = z.object({
    answer: S2sPairingAnswerSchema,
    scope: z.enum(["sandbox", "person"]),
    grants: S2sGrantsSchema.prefault({}).describe("What this sandbox lets the other one do here."),
});
export type S2sPaired = z.infer<typeof S2sPairedSchema>;

/* UPGRADES: an existing link or route pairing vouching, once, for the asking side's key. */

// POST /link/upgrade (under the link's own token) and POST /account/pairings/upgrade (under the pass and the pairing).
export const S2sUpgradeRequestSchema = z.object({
    document: SandboxIdentitySchema.describe("The asking sandbox's document."),
    grants: S2sGrantsSchema.prefault({}).describe("What the asking sandbox lets the taking one do there; a link gave nothing back, so messages."),
    wake: z.string().min(32).max(200).optional().describe("The asking sandbox's wake secret, when it grants `wake`."),
});
export type S2sUpgradeRequest = z.infer<typeof S2sUpgradeRequestSchema>;
export const S2sUpgradeAnswerSchema = z.object({
    contact: contactId.describe("The contact the taking side filed from the link's terms or the pairing."),
    document: SandboxIdentitySchema.describe("The taking sandbox's document."),
    grants: S2sGrantsSchema.describe("What it lets the asking sandbox do: the link's terms, or a person's route."),
    wake: z.string().min(32).max(200).optional(),
});
export type S2sUpgradeAnswer = z.infer<typeof S2sUpgradeAnswerSchema>;
export const S2sLinkUpgradeRequestSchema = S2sUpgradeRequestSchema;
export const S2sLinkUpgradeAnswerSchema = S2sUpgradeAnswerSchema;
export const S2sPairingUpgradeRequestSchema = S2sUpgradeRequestSchema;
export const S2sPairingUpgradeAnswerSchema = S2sUpgradeAnswerSchema;

// POST /account/contact-bootstrap, under a report pass: the first report to a sandbox with no contact files one holding
// only the `report` grant, and every later report is a message.
export const S2sContactBootstrapRequestSchema = z.object({ document: SandboxIdentitySchema });
export type S2sContactBootstrapRequest = z.infer<typeof S2sContactBootstrapRequestSchema>;
export const S2sContactBootstrapAnswerSchema = z.object({
    contact: contactId,
    document: SandboxIdentitySchema,
    grants: S2sGrantsSchema,
});
export type S2sContactBootstrapAnswer = z.infer<typeof S2sContactBootstrapAnswerSchema>;

/* IDENTITY, as the Messages tab's Identity section shows it. */

export const S2sDomainClaimSchema = z.object({
    domain: S2sDomainSchema,
    verified: z.boolean().describe("Its TXT record matched at the last check, so the document lists it."),
    record: z.object({
        name: z.string().describe("Where to publish it: `_intentic.<domain>`."),
        value: z.string().describe("What to publish: `v=isk1 fp=<fingerprint> host=<host>`."),
    }),
    claimedAt: z.number().int(),
    checkedAt: z.number().int().optional(),
    problem: z.string().max(500).optional().describe("What the last check found instead, in words."),
});
export type S2sDomainClaim = z.infer<typeof S2sDomainClaimSchema>;

export const S2sMeSchema = z.object({
    document: SandboxIdentitySchema.describe("This sandbox's own document, as GET /s2s/identity serves it."),
    domains: z.array(S2sDomainClaimSchema).describe("Every own domain claimed here, verified or waiting for its record."),
    recovery: z.boolean().describe("A recovery key is set."),
    previousKeys: z.number().int().nonnegative().describe("How many earlier key sets are kept to open late arrivals."),
});
export type S2sMe = z.infer<typeof S2sMeSchema>;
export const S2sDomainInputSchema = z.object({ domain: z.string().trim().min(1).max(253) });
export type S2sDomainInput = z.infer<typeof S2sDomainInputSchema>;
// POST /s2s/me/recovery: the recovery secret, shown this once.
export const S2sRecoveryMintedSchema = z.object({
    secret: z.string().describe("Keep it off this sandbox: it is what recovers this identity if the sandbox's volume is lost."),
    fingerprint: S2sRecoveryFingerprintSchema,
});
export type S2sRecoveryMinted = z.infer<typeof S2sRecoveryMintedSchema>;
export const S2sRecoverInputSchema = z.object({ secret: z.string().trim().min(1).max(400) });
export type S2sRecoverInput = z.infer<typeof S2sRecoverInputSchema>;

/* ATTESTATIONS, as the Identity section lists them (messages.md, "Attestations"): what other sandboxes signed about this
   one and a person here added to its identity, and the two sends that ask for one and issue one. */

export const S2sAttestationRowSchema = z.object({
    id: z.string().min(1).max(64).describe("The attestation's id (attestationIdOf): what removing it names."),
    attestation: S2sAttestationSchema,
    contact: S2sRefSchema.optional().describe("The contact it came from."),
    message: S2sEnvelopeIdSchema.optional().describe("The message that carried it, in that contact's thread."),
    acceptedAt: z.number().int().describe("When a person here added it."),
    verified: z.boolean().describe("It verifies against this sandbox's document now: its issuer's keys and signature, its dates and its subject."),
    problem: z.string().max(500).optional().describe("Why it does not, in words: lapsed, or about a key two rotations back."),
    published: z.boolean().describe("This sandbox's document carries it now, which it does exactly while it verifies."),
});
export type S2sAttestationRow = z.infer<typeof S2sAttestationRowSchema>;
export const S2sAttestationsSchema = z.object({ attestations: z.array(S2sAttestationRowSchema).describe("Newest first.") });
export type S2sAttestations = z.infer<typeof S2sAttestationsSchema>;
// POST /s2s/me/attestations: add the attestation a contact sent (its `attestation.issued` message) to this identity, once
// it verifies against this sandbox's own document. One per issuer: a newer one from the same issuer replaces the older.
export const S2sAttestationAcceptSchema = z.object({ message: S2sEnvelopeIdSchema.describe("The attestation.issued message, by its id.") });
export type S2sAttestationAccept = z.infer<typeof S2sAttestationAcceptSchema>;
// POST /s2s/me/attestations/ask: ask a sandbox-scoped contact to vouch for this sandbox (`attestation.request`).
export const S2sAttestationAskSchema = z.object({
    contact: S2sRefSchema.describe("The contact asked, by its id here."),
    claims: S2sClaimsSchema.prefault({}).describe("What it is asked to vouch for; the contact decides what it signs."),
    note: z.string().max(S2S_NOTE_MAX).optional(),
});
export type S2sAttestationAsk = z.infer<typeof S2sAttestationAskSchema>;
// POST /s2s/attestations/issue: vouch for a sandbox-scoped contact, signed now by this sandbox's key for the contact's
// pinned key, and sent to it (`attestation.issued`).
export const S2sAttestationIssueSchema = z.object({
    contact: S2sRefSchema.describe("The contact vouched for, by its id here."),
    claims: S2sClaimsSchema,
    validUntil: z.number().int().describe("When it lapses, in epoch milliseconds: later than now, at most a year from now."),
    note: z.string().max(S2S_NOTE_MAX).optional(),
    replyTo: S2sEnvelopeIdSchema.optional().describe("The contact's attestation.request it answers; the vouch goes into that thread."),
});
export type S2sAttestationIssue = z.infer<typeof S2sAttestationIssueSchema>;

/* THREADS AND MESSAGES, as the Inbox shows them. */

export const S2sDirectionSchema = z.enum(["in", "out"]);
export const S2sDeliveryStateSchema = z
    .enum(["queued", "sent", "undelivered"])
    .describe("queued: in the outbox. sent: the far side took it. undelivered: refused, or not taken within a week.");
export type S2sDeliveryState = z.infer<typeof S2sDeliveryStateSchema>;

export const S2sAttachmentMetaSchema = z.object({
    name: z.string().min(1).max(200),
    size: z.number().int().nonnegative(),
});
export type S2sAttachmentMeta = z.infer<typeof S2sAttachmentMetaSchema>;

export const S2sThreadMessageSchema = z.object({
    id: S2sEnvelopeIdSchema,
    thread: S2sRefSchema,
    contact: contactId,
    direction: S2sDirectionSchema,
    kind: S2sPayloadKindSchema.describe("message, report, contact.request, a task's kind or an attestation's: what the thread shows."),
    subject: z.string().max(S2S_SUBJECT_MAX).optional(),
    text: z.string().describe("The words, or for a report or a task the line it is shown by."),
    attachments: z.array(S2sAttachmentMetaSchema),
    as: S2sPersonSchema.optional().describe("The person a person-scoped contact carried it for."),
    replyTo: S2sEnvelopeIdSchema.optional(),
    claims: S2sClaimsSchema.optional().describe("An attestation.request's claims: what it asks to be vouched for."),
    attestation: S2sAttestationSchema.optional().describe("An attestation.issued's attestation, whole."),
    sentAt: z.number().int(),
    receivedAt: z.number().int().optional(),
    read: z.boolean(),
    delivery: z
        .object({
            state: S2sDeliveryStateSchema,
            attempts: z.number().int().nonnegative(),
            reason: z.string().max(500).optional().describe("Why it waits, or why it was not delivered."),
        })
        .optional()
        .describe("A sent message's delivery; absent on one received."),
});
export type S2sThreadMessage = z.infer<typeof S2sThreadMessageSchema>;

export const S2sThreadSummarySchema = z.object({
    id: S2sRefSchema,
    contact: contactId,
    contactName: z.string(),
    scope: S2sContactScopeSchema,
    subject: z.string().max(S2S_SUBJECT_MAX).optional(),
    last: z.object({ at: z.number().int(), direction: S2sDirectionSchema, preview: z.string().max(200) }),
    unread: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    undelivered: z.number().int().nonnegative().describe("Sent messages in it that were not delivered."),
});
export type S2sThreadSummary = z.infer<typeof S2sThreadSummarySchema>;
export const S2sThreadsListSchema = z.object({
    threads: z.array(S2sThreadSummarySchema),
    requests: z.number().int().nonnegative().describe("Contact requests waiting on a person, for the tab's badge."),
});
export type S2sThreadsList = z.infer<typeof S2sThreadsListSchema>;
export const S2sThreadSchema = z.object({ thread: S2sThreadSummarySchema, messages: z.array(S2sThreadMessageSchema) });
export type S2sThread = z.infer<typeof S2sThreadSchema>;

/* SENDING, and the outbox. */

// POST /s2s/messages: a person in the editor, or an agent through `messages send` with its turn proof.
export const S2sMessageSendSchema = z.object({
    to: contactId.describe("The contact, by its id here."),
    text: z.string().max(S2S_MESSAGE_TEXT_MAX),
    subject: z.string().max(S2S_SUBJECT_MAX).optional(),
    thread: S2sRefSchema.optional().describe("The thread it continues; absent opens a new one."),
    replyTo: S2sEnvelopeIdSchema.optional(),
    files: z.array(S2sAttachmentSchema).max(S2S_MESSAGE_FILES_MAX).default([]).describe("Each file's own name and its bytes in base64."),
});
export type S2sMessageSend = z.infer<typeof S2sMessageSendSchema>;
export const S2sMessageSendOutcomeSchema = z.discriminatedUnion("state", [
    z.object({ state: z.literal("queued"), id: S2sEnvelopeIdSchema, thread: S2sRefSchema }),
    z.object({ state: z.literal("refused"), reason: z.string() }),
    z.object({ state: z.literal("asked"), reason: z.string(), needId: z.string().describe("The card a person answers before it goes.") }),
]);
export type S2sMessageSendOutcome = z.infer<typeof S2sMessageSendOutcomeSchema>;

// POST /s2s/messages/{id}/take: copy a received message's files into a folder of the workspace.
export const S2sTakeSchema = DropTakeSchema.extend({
    files: z.array(z.string().min(1).max(200)).max(S2S_MESSAGE_FILES_MAX).optional().describe("Only these, by name; absent, all."),
});
export type S2sTake = z.infer<typeof S2sTakeSchema>;
export const S2sTakenSchema = DropTakenSchema;

export const S2sOutboxEntrySchema = z.object({
    id: S2sEnvelopeIdSchema,
    contact: contactId,
    contactName: z.string(),
    kind: S2sPayloadKindSchema,
    thread: S2sRefSchema.optional(),
    state: z.enum(["waiting", "undelivered"]),
    attempts: z.number().int().nonnegative(),
    firstAt: z.number().int(),
    nextAt: z.number().int().optional().describe("When it is tried next, while waiting."),
    lastError: z.string().max(500).optional(),
});
export type S2sOutboxEntry = z.infer<typeof S2sOutboxEntrySchema>;
export const S2sOutboxSchema = z.object({ entries: z.array(S2sOutboxEntrySchema) });
export type S2sOutbox = z.infer<typeof S2sOutboxSchema>;

// TASKS CONTACTS HANDED THIS SANDBOX (messages.md, "Tasks"): what `GET /s2s/tasks` lists for the Messages tab, each shown
// to whoever may use its contact, and what `POST /s2s/contacts/{id}/tasks/{request}` answers with. A sandbox-scoped
// contact's task may wait for the owner (its `task` grant's `approve`); a person-scoped one never does.
export const S2sContactTaskSchema = z.object({
    contact: contactId,
    contactName: z.string(),
    requestId: z.string().describe("The asking side's own id for the task; the decision names it."),
    conversationId: z.string().describe("The conversation it opened here."),
    title: z.string().optional(),
    task: z.string().max(2_000).optional().describe("Its words while its first turn has not been said (cut), the Allow's to read."),
    state: z.enum(["held", "running", "finished", "failed", "declined", "stopped"]).describe("held waits for the owner's Allow."),
    askedAt: z.number().int(),
    updatedAt: z.number().int(),
});
export type S2sContactTask = z.infer<typeof S2sContactTaskSchema>;
export const S2sContactTasksSchema = z.object({ tasks: z.array(S2sContactTaskSchema).describe("Waiting ones first, then the newest.") });
export type S2sContactTasks = z.infer<typeof S2sContactTasksSchema>;
export const S2sContactTaskDecisionSchema = z.object({ approve: z.boolean().describe("Start it now, or decline it: nothing of it runs.") });
export type S2sContactTaskDecision = z.infer<typeof S2sContactTaskDecisionSchema>;
