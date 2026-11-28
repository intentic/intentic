import { z } from "zod";
import { DROP_BYTES_MAX, DROP_FILES_MAX, DropFileSchema } from "./account-routes.js";
import { ConversationBundleSchema, DiagnosticsAnswerSchema, DiagnosticsQuerySchema } from "./diagnostics.js";
import { AccountReportSchema } from "./issues.js";
import {
    LINK_MAX_HOPS,
    LINK_OPERATE_WAIT_S_MAX,
    LinkAnswerSchema,
    LinkExecSchema,
    LinkExecStatusSchema,
    LinkMessageSchema,
    LinkReadAnswerSchema,
    LinkReadSchema,
    LinkTaskSchema,
    LinkTaskStatusSchema,
    LinkWriteAnswerSchema,
    LinkWriteSchema,
} from "./links.js";
import {
    HybridSigSchema,
    S2sAddressSchema,
    S2sBase64UrlSchema,
    S2sContactScopeSchema,
    S2sFingerprintSchema,
    S2sGrantsSchema,
    S2S_NOTE_MAX,
    S2sPersonSchema,
    S2sRefSchema,
    SandboxIdentitySchema,
} from "./s2s-identity.js";

// SANDBOX-TO-SANDBOX (docs/architecture/messages.md), the wire half: the envelope a message travels in, every kind of
// payload it can carry, what the inbox door answers, and the call sessions records and operating go through.
// Re-exported from schemas/s2s.ts.

// The sealed body's cap, in bytes; past it the door answers 413 `too_large` before reading further.
export const S2S_BODY_MAX_BYTES = 16 * 1024 * 1024;
// The same cap as base64url characters, the body field's own length.
export const S2S_BODY_MAX_CHARS = Math.ceil(S2S_BODY_MAX_BYTES / 3) * 4;
// The whole POST /s2s/inbox request: the body and room for the header, the key agreement and the signature.
export const S2S_ENVELOPE_MAX_BYTES = S2S_BODY_MAX_CHARS + 64 * 1024;
// A message's own limits: the drops' file count and bytes, and words.
export const S2S_MESSAGE_FILES_MAX = DROP_FILES_MAX;
export const S2S_MESSAGE_BYTES_MAX = DROP_BYTES_MAX;
export const S2S_MESSAGE_TEXT_MAX = 60_000;
export const S2S_SUBJECT_MAX = 200;
// How long an envelope id is remembered, so a retry of one already taken answers 200 and changes nothing.
export const S2S_SEEN_IDS_MS = 30 * 24 * 60 * 60 * 1000;
// How far an envelope's `sentAt` may be from the receiver's clock when it arrives: at most a day behind, at most five
// minutes ahead. The outbox seals afresh at every attempt, so an honest envelope is seconds old; one past either bound is
// refused `replay`, and a day sits well inside the time its id is remembered, so no id is forgotten while it could still be
// taken (2026-11-27).
export const S2S_ENVELOPE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const S2S_ENVELOPE_MAX_AHEAD_MS = 5 * 60 * 1000;
// What a stranger (no contact) may send: contact requests only, this many an hour per address and in all.
export const S2S_STRANGER_REQUESTS_PER_ADDRESS_HOUR = 3;
export const S2S_STRANGER_REQUESTS_PER_HOUR = 30;
// The per-contact minute limit by kind, as the passes had.
export const S2S_PER_MINUTE = { message: 60, report: 30, task: 10 } as const;
// The outbox: retried for a week, `min(30 s · 2^n, 30 min)` unless the far side says Retry-After.
export const S2S_OUTBOX_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const S2S_OUTBOX_BACKOFF_BASE_MS = 30_000;
export const S2S_OUTBOX_BACKOFF_MAX_MS = 30 * 60 * 1000;
// The query parameter an attempt to a contact holding this sandbox's wake grant carries its secret in.
export const S2S_WAKE_QUERY = "wake";
// Calls: the header naming the session, how long a session lives, and how far a call's clock may be from the callee's.
export const S2S_SESSION_HEADER = "x-intentic-s2s-session";
export const S2S_SESSION_TTL_MS = 60 * 60 * 1000;
export const S2S_CALL_SKEW_MS = 2 * 60 * 1000;

// An envelope's id: a UUIDv7, so ids sort by when they were made.
export const S2sEnvelopeIdSchema = z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    .describe("A UUIDv7.");

export const S2S_PAYLOAD_KINDS = [
    "contact.request",
    "contact.accept",
    "contact.update",
    "contact.remove",
    "identity.rotated",
    "message",
    "report",
    "task.request",
    "task.update",
    "task.message",
    "task.answer",
    "task.stop",
    "receipt",
] as const;
export const S2sPayloadKindSchema = z.enum(S2S_PAYLOAD_KINDS);
export type S2sPayloadKind = z.infer<typeof S2sPayloadKindSchema>;
export const isS2sPayloadKind = (kind: string): kind is S2sPayloadKind => S2S_PAYLOAD_KINDS.some((known) => known === kind);

// The header, in the clear and signed. `kind` is any word here so a kind this build does not know is refused by name
// (422 `unknown_kind`), never misread. Loose, as the identity document is, so a later field still verifies; the type
// names the fields this build knows.
const headerFields = {
    v: z.literal(1),
    id: S2sEnvelopeIdSchema,
    from: S2sAddressSchema.describe("The sender's address, as the receiver knows it."),
    fromFp: S2sFingerprintSchema.describe("The key set the sender signed with."),
    to: S2sAddressSchema.describe("The receiver's address."),
    toFp: S2sFingerprintSchema.describe("The receiver's key set the body is sealed to: its current one or a kept previous one."),
    kind: z.string().min(1).max(64).describe("The payload's kind (S2S_PAYLOAD_KINDS)."),
    thread: S2sRefSchema.optional().describe("The thread it belongs to, as the sender names it."),
    replyTo: S2sEnvelopeIdSchema.optional().describe("The envelope it answers."),
    as: S2sPersonSchema.optional().describe("The person of a person-scoped contact it travels for."),
    hops: z.number().int().min(0).max(10).describe("How many sandboxes the work it carries already crossed (LINK_MAX_HOPS)."),
    sentAt: z.number().int().nonnegative().describe("When it was sealed, in epoch milliseconds."),
};
export const S2sEnvelopeHeaderSchema = z.looseObject(headerFields);
export type S2sEnvelopeHeader = z.infer<z.ZodObject<typeof headerFields>>;

// The hybrid key agreement to the receiver's key set: an ephemeral X25519 key, an ML-KEM-768 ciphertext, the AEAD nonce.
export const S2sEncSchema = z.object({
    x25519: S2sBase64UrlSchema.describe("The sender's ephemeral X25519 public key, 32 bytes."),
    mlkem768: S2sBase64UrlSchema.describe("The ML-KEM-768 ciphertext to the receiver's key, 1088 bytes."),
    nonce: S2sBase64UrlSchema.describe("The AES-256-GCM nonce, 12 bytes."),
});
export type S2sEnc = z.infer<typeof S2sEncSchema>;

const envelopeFields = {
    ...headerFields,
    enc: S2sEncSchema,
    body: S2sBase64UrlSchema.max(S2S_BODY_MAX_CHARS).describe("The payload as JSON, sealed with AES-256-GCM; the tag at its end."),
    sig: HybridSigSchema.describe("The sender's signature over the canonical header, `enc` and `body`."),
};
export const S2sEnvelopeSchema = z.looseObject(envelopeFields).describe("One signed, encrypted message between two sandboxes (POST /s2s/inbox).");
export type S2sEnvelope = z.infer<z.ZodObject<typeof envelopeFields>>;

/* PAYLOADS: the body, once opened, by kind. */

// A message's file, whole: its own name (never a path) and its bytes in base64, as a drop carried them.
export const S2sAttachmentSchema = DropFileSchema;
export type S2sAttachment = z.infer<typeof S2sAttachmentSchema>;

const wakeSecret = z.string().min(32).max(200).describe("This sandbox's wake secret, handed to a contact it grants `wake`.");
const taskRef = S2sRefSchema.describe("The task, by the asking side's own request id for it (LinkTask `requestId`).");

export const S2sContactRequestSchema = z.object({
    kind: z.literal("contact.request"),
    document: SandboxIdentitySchema.describe("The asking sandbox's identity; the receiver confirms it by fetching it from the claimed address."),
    note: z.string().max(S2S_NOTE_MAX).optional().describe("Why it asks, in its own words."),
    grants: S2sGrantsSchema.describe("What the asking sandbox gives the receiver, informational there."),
    scope: S2sContactScopeSchema,
    wake: wakeSecret.optional(),
});
export const S2sContactAcceptSchema = z.object({
    kind: z.literal("contact.accept"),
    document: SandboxIdentitySchema,
    grants: S2sGrantsSchema.describe("What the accepting sandbox gives the asking one."),
    wake: wakeSecret.optional(),
});
export const S2sContactUpdateSchema = z.object({
    kind: z.literal("contact.update"),
    grants: S2sGrantsSchema.optional().describe("The grants as they are now, when they changed."),
    wake: wakeSecret.nullable().optional().describe("A new wake secret, or null when the grant was taken away."),
});
export const S2sContactRemoveSchema = z.object({
    kind: z.literal("contact.remove"),
    reason: z.string().max(S2S_NOTE_MAX).optional(),
});
export const S2sIdentityRotatedSchema = z.object({
    kind: z.literal("identity.rotated"),
    document: SandboxIdentitySchema.describe("The new document; its `prev` is signed by the key the contact pinned, or by the recovery key."),
});
export const S2sMessagePayloadSchema = z.object({
    kind: z.literal("message"),
    subject: z.string().max(S2S_SUBJECT_MAX).optional(),
    text: z.string().max(S2S_MESSAGE_TEXT_MAX),
    attachments: z.array(S2sAttachmentSchema).max(S2S_MESSAGE_FILES_MAX).default([]),
});
// A problem report, the account report's own fields (schemas/issues.ts), handed to the issues extension as before, and the
// project it is about, which a pass used to carry.
export const S2sReportPayloadSchema = AccountReportSchema.extend({
    kind: z.literal("report"),
    project: z.string().min(1).max(200).describe("The project it is about, as the receiving sandbox claims it (github.com/owner/repo)."),
});
// A task, the link task's own fields (schemas/links.ts).
export const S2sTaskRequestSchema = LinkTaskSchema.extend({ kind: z.literal("task.request") });
export const S2sTaskUpdateSchema = z.object({ kind: z.literal("task.update"), task: taskRef, status: LinkTaskStatusSchema });
export const S2sTaskMessageSchema = z.object({ kind: z.literal("task.message"), task: taskRef, message: LinkMessageSchema });
export const S2sTaskAnswerSchema = z.object({ kind: z.literal("task.answer"), task: taskRef, answer: LinkAnswerSchema });
export const S2sTaskStopSchema = z.object({ kind: z.literal("task.stop"), task: taskRef });
export const S2sReceiptSchema = z.object({
    kind: z.literal("receipt"),
    of: S2sEnvelopeIdSchema.describe("The envelope it is about."),
    read: z.boolean().describe("A person (or the turn acting for one) read it."),
    at: z.number().int().nonnegative(),
});

export const S2sPayloadSchema = z.discriminatedUnion("kind", [
    S2sContactRequestSchema,
    S2sContactAcceptSchema,
    S2sContactUpdateSchema,
    S2sContactRemoveSchema,
    S2sIdentityRotatedSchema,
    S2sMessagePayloadSchema,
    S2sReportPayloadSchema,
    S2sTaskRequestSchema,
    S2sTaskUpdateSchema,
    S2sTaskMessageSchema,
    S2sTaskAnswerSchema,
    S2sTaskStopSchema,
    S2sReceiptSchema,
]);
export type S2sPayload = z.infer<typeof S2sPayloadSchema>;
export type S2sPayloadOf<K extends S2sPayloadKind> = Extract<S2sPayload, { readonly kind: K }>;

/* THE INBOX DOOR's answers. */

export const S2sInboxAcceptedSchema = z.object({
    ok: z.literal(true),
    id: S2sEnvelopeIdSchema,
    duplicate: z.boolean().optional().describe("It had already arrived; nothing changed."),
});
export type S2sInboxAccepted = z.infer<typeof S2sInboxAcceptedSchema>;

// Why a door refused, with the status it answers. A blocked sender is never told: it is answered as if accepted.
export const S2S_REFUSAL_CODES = [
    "malformed",
    "signature",
    "not_contact",
    "grant",
    "floor",
    "key_changed",
    "unconfirmed",
    "recipient",
    "hops",
    "too_large",
    "unknown_kind",
    "rate",
    "unready",
    "task",
    "session",
    "replay",
] as const;
export const S2sRefusalCodeSchema = z
    .enum(S2S_REFUSAL_CODES)
    .describe(
        "malformed: not an envelope. signature: it does not verify against the pinned key. not_contact: a stranger may only ask to be one. grant: the contact lacks the grant for this kind. floor: a person-scoped contact's person is not on the roster above the kind's floor. key_changed: held until a person trusts the new key. unconfirmed: a request's document is not what its address serves. recipient: not this sandbox's address or key. hops: crossed too many sandboxes. too_large: past the size cap. unknown_kind: a kind this build does not know. rate: past the per-contact minute limit (retried). unready: nothing here takes this kind yet (retried). task: the task cannot be taken or acted on as asked (no such task, one not allowed yet or declined, the task grant's hourly turns spent), in words, never retried. session: a call names no session this sandbox holds (it expired, this sandbox restarted, or a key changed since it opened): open a new one. replay: a call or session request outside the clock window, or one seen before; an envelope sealed more than a day before it arrived or more than five minutes ahead of the receiver's clock.",
    );
export type S2sRefusalCode = z.infer<typeof S2sRefusalCodeSchema>;
// 403, 409 and 422 end a send at once; 429 and 503 are tried again. Never 401, which a sender reads as a daemon too old
// for the door.
export const S2S_REFUSAL_STATUS = {
    malformed: 400,
    signature: 403,
    not_contact: 403,
    grant: 403,
    floor: 403,
    key_changed: 403,
    unconfirmed: 403,
    recipient: 409,
    hops: 409,
    too_large: 413,
    unknown_kind: 422,
    rate: 429,
    unready: 503,
    task: 409,
    session: 409,
    replay: 409,
} as const satisfies Record<S2sRefusalCode, number>;
export const S2sRefusalSchema = z.object({
    error: z.string().describe("Why, in words a person can act on."),
    code: S2sRefusalCodeSchema,
});
export type S2sRefusal = z.infer<typeof S2sRefusalSchema>;

/* CALLS: records and operating, request and response under a session key; nothing stored or retried. */

// POST /s2s/session: a fresh key agreement to the callee's key, signed by the caller. Loose for the same reason as the
// envelope header: the signature covers every field.
const sessionOpenFields = {
    v: z.literal(1),
    from: S2sAddressSchema,
    fromFp: S2sFingerprintSchema,
    to: S2sAddressSchema,
    toFp: S2sFingerprintSchema,
    as: S2sPersonSchema.optional().describe("The person of a person-scoped contact the calls are for."),
    at: z.number().int().nonnegative().describe("When it was made, in epoch milliseconds; within S2S_CALL_SKEW_MS of the callee's clock."),
    nonce: S2sBase64UrlSchema.describe("16 random bytes."),
    enc: S2sEncSchema.omit({ nonce: true }),
    sig: HybridSigSchema.describe("The caller's signature over the canonical request without `sig`."),
};
export const S2sSessionOpenSchema = z.looseObject(sessionOpenFields);
export type S2sSessionOpen = z.infer<z.ZodObject<typeof sessionOpenFields>>;

export const S2sSessionAnswerSchema = z.object({
    session: S2sRefSchema.describe("The session's id, sent back in x-intentic-s2s-session on every call."),
    expiresAt: z.number().int().describe("When the callee forgets it, in epoch milliseconds."),
    confirm: S2sBase64UrlSchema.describe("HMAC-SHA256 under the session key over the session id: the callee derived the same key."),
});
export type S2sSessionAnswer = z.infer<typeof S2sSessionAnswerSchema>;

// What a sealed answer opens to: the method's status and what it answered, its output (S2S_CALLS) at 200 and a refusal in
// words (`error`, or the fleet reads' own `message`) otherwise. Sealed whole, so the edge reads no more of an answer than
// that one came back.
export const S2sCallAnswerSchema = z.object({
    status: z.number().int().min(200).max(599).describe("The method's own status: 200, or why it refused (404 nothing by that name, 409, 429, 503)."),
    body: z.unknown().describe("The method's output at 200; a refusal in words otherwise."),
});
export type S2sCallAnswer = z.infer<typeof S2sCallAnswerSchema>;

// A call's body or its answer, sealed under the session key with a fresh nonce.
export const S2sCallSealedSchema = z.object({
    at: z.number().int().nonnegative().describe("When it was sealed, in epoch milliseconds."),
    nonce: S2sBase64UrlSchema.describe("12 random bytes, never seen before in the session."),
    body: S2sBase64UrlSchema.max(S2S_BODY_MAX_CHARS).describe("The method's input or answer as JSON, AES-256-GCM sealed."),
});
export type S2sCallSealed = z.infer<typeof S2sCallSealedSchema>;

export const S2S_CALL_METHODS = [
    "records.fleet",
    "records.show",
    "records.bundle",
    "records.diagnostics",
    "operate.exec",
    "operate.status",
    "operate.stop",
    "operate.read",
    "operate.write",
    "task.watch",
] as const;
export const S2sCallMethodSchema = z.enum(S2S_CALL_METHODS);
export type S2sCallMethod = z.infer<typeof S2sCallMethodSchema>;

const handle = z.string().min(1).max(200).describe("A conversation, by handle or id, as `agents show` takes it.");
// The rest of a fleet read's query, as `agents ls|find|show` spell it over HTTP (limit, all, repo, owner, transcript, last,
// grep, message, raw, stored, diff…).
const fleetQuery = z.record(z.string().max(40), z.string().max(2000)).optional().describe("The read's other query parameters, as `agents ls|show` send them.");
// The fleet reads answer what the `agents` command's own routes answer, which share no schema yet.
const FleetAnswerSchema = z.record(z.string(), z.unknown()).describe("What `agents ls|find|show` answers here.");

const commandId = z.string().min(1).max(100).describe("The command, by the id operate.exec answered.");
export const S2sOperateStatusInputSchema = z.object({
    id: commandId,
    waitS: z.number().int().min(0).max(LINK_OPERATE_WAIT_S_MAX).optional().describe("Hold the call this long for it to end."),
});
export const S2sTaskWatchInputSchema = z.object({
    task: taskRef,
    after: z.number().int().nonnegative().optional().describe("Answer once the status's version moves past this one."),
    waitS: z.number().int().min(0).max(25).optional(),
});

// Each method's input and answer, opened from the sealed call and answer.
export const S2S_CALLS = {
    "records.fleet": { grant: "records", input: z.object({ q: z.string().max(200).optional(), query: fleetQuery }), output: FleetAnswerSchema },
    "records.show": { grant: "records", input: z.object({ handle, query: fleetQuery }), output: FleetAnswerSchema },
    "records.bundle": { grant: "records", input: z.object({ handle }), output: ConversationBundleSchema },
    "records.diagnostics": { grant: "records", input: DiagnosticsQuerySchema, output: DiagnosticsAnswerSchema },
    "operate.exec": { grant: "operate", input: LinkExecSchema, output: LinkExecStatusSchema },
    "operate.status": { grant: "operate", input: S2sOperateStatusInputSchema, output: LinkExecStatusSchema },
    "operate.stop": { grant: "operate", input: z.object({ id: commandId }), output: LinkExecStatusSchema },
    "operate.read": { grant: "operate", input: LinkReadSchema, output: LinkReadAnswerSchema },
    "operate.write": { grant: "operate", input: LinkWriteSchema, output: LinkWriteAnswerSchema },
    "task.watch": { grant: "task", input: S2sTaskWatchInputSchema, output: LinkTaskStatusSchema },
} as const satisfies Record<S2sCallMethod, { readonly grant: "records" | "operate" | "task"; readonly input: z.ZodType; readonly output: z.ZodType }>;
export type S2sCallInput<M extends S2sCallMethod> = z.input<(typeof S2S_CALLS)[M]["input"]>;
export type S2sCallOutput<M extends S2sCallMethod> = z.output<(typeof S2S_CALLS)[M]["output"]>;

// LINK_MAX_HOPS, under the name the inbox's hop check reads.
export const S2S_MAX_HOPS = LINK_MAX_HOPS;
