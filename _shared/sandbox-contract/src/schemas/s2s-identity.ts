import { z } from "zod";
import { LinkTermsSchema } from "./links.js";

// SANDBOX-TO-SANDBOX (docs/architecture/messages.md), the identity half: what a sandbox is to another one (an address
// and a hybrid post-quantum key set, published as a signed document), and what it lets a contact do here. Re-exported
// from schemas/s2s.ts with the wire and editor shapes; the primitives that make and check these live in protocol/s2s/.

// The protocol a daemon speaks when it answers GET /s2s/identity, named in every identity document it publishes.
export const S2S_PROTOCOL = "s2s/1";
// The HKDF info and signing prefix: every key this protocol derives and every signature it makes is bound to it.
export const S2S_INFO = "intentic-s2s/1";
// A key set's fingerprint: this prefix and the lowercase base32 (RFC 4648, no padding) of a SHA-256, 52 characters.
export const S2S_FINGERPRINT_PREFIX = "isk1:";
// A recovery key's fingerprint, prefixed apart so the one can never be read as the other.
export const S2S_RECOVERY_PREFIX = "isr1:";
// What a recovery secret looks like: this prefix and the base64url of its two signing seeds.
export const S2S_RECOVERY_SECRET_PREFIX = "isrs1.";
// The DNS name an own domain publishes its record under: `_intentic.<domain>`.
export const S2S_TXT_LABEL = "_intentic";
// How many earlier key sets the key store keeps, so an envelope sealed to a key just rotated away still opens.
export const S2S_PREVIOUS_KEYS_MAX = 3;
// How many own domains one identity document lists.
export const S2S_DOMAINS_MAX = 16;

// How long a person's note on a request, a removal or a contact need may be.
export const S2S_NOTE_MAX = 1_000;

// A contact's, a thread's or a task's id, or another id one side gave and the other repeats back.
export const S2sRefSchema = z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);

// Bytes on the wire: base64url (RFC 4648 §5), no padding.
export const S2sBase64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]*$/u, "base64url, without padding");

export const S2sFingerprintSchema = z
    .string()
    .regex(/^isk1:[a-z2-7]{52}$/u)
    .describe("A key set's fingerprint: `isk1:` and the base32 of the SHA-256 over its canonical public keys. What a person compares and a contact pins.");
export type S2sFingerprint = z.infer<typeof S2sFingerprintSchema>;

export const S2sRecoveryFingerprintSchema = z
    .string()
    .regex(/^isr1:[a-z2-7]{52}$/u)
    .describe("A recovery key's fingerprint: `isr1:` and the base32 of the SHA-256 over its canonical public signing keys.");

// The two signature algorithms' public keys, base64url: what a recovery key is, and half of a key set.
export const S2sSigningKeysSchema = z.object({
    ed25519: S2sBase64UrlSchema.describe("Ed25519 public key, 32 bytes."),
    mldsa65: S2sBase64UrlSchema.describe("ML-DSA-65 public key, 1952 bytes."),
});
export type S2sSigningKeys = z.infer<typeof S2sSigningKeysSchema>;

// A whole public key set: the signing pair and the key-agreement pair.
export const S2sPublicKeysSchema = S2sSigningKeysSchema.extend({
    x25519: S2sBase64UrlSchema.describe("X25519 public key, 32 bytes."),
    mlkem768: S2sBase64UrlSchema.describe("ML-KEM-768 encapsulation key, 1184 bytes."),
});
export type S2sPublicKeys = z.infer<typeof S2sPublicKeysSchema>;

// Every signature is hybrid: both halves over the same bytes, and both must verify.
export const HybridSigSchema = z
    .object({
        ed25519: S2sBase64UrlSchema.describe("Ed25519 signature, 64 bytes."),
        mldsa65: S2sBase64UrlSchema.describe("ML-DSA-65 signature, 3309 bytes."),
    })
    .describe("A hybrid signature: Ed25519 and ML-DSA-65 over the same bytes. Either alone verifies nothing.");
export type HybridSig = z.infer<typeof HybridSigSchema>;

// A DNS name in lowercase ASCII (an IDN in its punycode): at least two labels, each 1-63 of a-z, 0-9 and inner hyphens.
const HOSTNAME = String.raw`(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`;

export const S2sDomainSchema = z
    .string()
    .max(253)
    .regex(new RegExp(`^${HOSTNAME}$`, "u"))
    .describe("An own domain, lowercase, no port: what a TXT record under `_intentic.<domain>` vouches for.");

// A host or an own domain; a host may carry a port, which only a loopback or a test daemon has.
export const S2sAddressSchema = z
    .string()
    .max(259)
    .regex(new RegExp(`^(?:${HOSTNAME}|localhost)(?::[0-9]{1,5})?$`, "u"))
    .describe("Where a sandbox is reached: its host (`<id>.<zone>`) or an own domain, lowercase.");
export type S2sAddress = z.infer<typeof S2sAddressSchema>;

// What an identity document's `prev` proves: that the key set before this one, or the recovery key, vouched for this
// one as its successor. The vouch is over the sandbox, the new fingerprint and itself, not the whole document, so the
// document can be signed again as its facts change without the voucher: a recovery key is never kept on the sandbox.
const vouchedAt = z.number().int().nonnegative().describe("When the vouch was made, in epoch milliseconds.");
const vouchSig = HybridSigSchema.describe("The voucher's signature over the canonical `{ sandbox, successor, by, fingerprint, at }`.");
export const S2sIdentityPrevSchema = z.discriminatedUnion("by", [
    z.object({
        by: z.literal("key"),
        fingerprint: S2sFingerprintSchema.describe("The previous key set's fingerprint."),
        keys: S2sPublicKeysSchema.describe("The previous key set's public keys, which the fingerprint is over."),
        at: vouchedAt,
        sig: vouchSig,
    }),
    z.object({
        by: z.literal("recovery"),
        fingerprint: S2sRecoveryFingerprintSchema.describe("The recovery key's fingerprint, as the earlier document published it."),
        keys: S2sSigningKeysSchema.describe("The recovery key's public signing keys, which the fingerprint is over."),
        at: vouchedAt,
        sig: vouchSig,
    }),
]);
export type S2sIdentityPrev = z.infer<typeof S2sIdentityPrevSchema>;

/* ATTESTATIONS (docs/architecture/messages.md, "Attestations"): another sandbox's signed word about this one, carried in
   this one's document. It says who vouched and for what, never that the claim is true; which issuers count is each
   reader's own choice, by fingerprint. Every object in one is loose: the document's signature covers it whole, so a
   field a later build adds must survive this build's parse, or the document would stop verifying here. */

// What a daemon reads of another's identity document at most (s2s-wiring.ts IDENTITY_BODY_MAX, which older daemons keep).
export const S2S_IDENTITY_MAX_BYTES = 64 * 1024;
// The most attestations a document lists as any reader parses it. A vouch carries its issuer's four public keys and a
// hybrid signature, about 10 KB, so no document under S2S_IDENTITY_MAX_BYTES comes near: this bound only refuses junk.
export const S2S_ATTESTATIONS_MAX = 16;
// The most this sandbox keeps and publishes: four of the largest vouches fit beside the largest document there is (sixteen
// domains and a `prev`) inside S2S_IDENTITY_MAX_BYTES (attestation.test.ts measures it).
export const S2S_ATTESTATIONS_KEPT_MAX = 4;
// How long one attestation may be valid from when it was issued: a year, so a vouch nobody renews lapses by itself.
export const S2S_ATTESTATION_VALID_MAX_MS = 365 * 24 * 60 * 60 * 1000;
// Claims: how many, how long a word may be, and how many bytes of JSON they come to whole. The bytes are what keeps four
// of the largest vouches inside S2S_IDENTITY_MAX_BYTES: at 1,024 the fullest document came to 66,104 bytes.
export const S2S_CLAIMS_MAX = 12;
export const S2S_CLAIM_VALUE_MAX = 120;
export const S2S_CLAIMS_BYTES_MAX = 768;
// The claims a reader can expect to mean the same whoever wrote them; any other key is the issuer's own word.
// `kind`: what the subject is (S2S_CLAIM_KINDS). `verifiedBy`: how the issuer checked (S2S_CLAIM_METHODS). `country`: an
// ISO 3166-1 alpha-2 code. `over18`: true when the issuer checked the person is an adult. `displayName`: the name the
// issuer knows the subject by. `organisation`: the organisation the subject is or belongs to.
export const S2S_WELL_KNOWN_CLAIMS = ["kind", "verifiedBy", "country", "over18", "displayName", "organisation"] as const;
export const S2S_CLAIM_KINDS = ["person", "organisation"] as const;
export const S2S_CLAIM_METHODS = ["in-person", "document", "domain", "employment"] as const;
// The types this build knows. `sandbox-vouch` it verifies; `eudi-pid` is a slot for an EU digital identity wallet's
// person identification data, parsed and never verified yet (it needs relying-party registration and a real wallet).
export const S2S_ATTESTATION_TYPES = ["sandbox-vouch", "eudi-pid"] as const;

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

export const S2sClaimKeySchema = z
    .string()
    .regex(/^[a-z][A-Za-z0-9_-]{0,39}$/u)
    .describe("A claim's name: a lowercase letter, then up to 39 letters, digits, `_` or `-` (S2S_WELL_KNOWN_CLAIMS).");
export const S2sClaimValueSchema = z.union([z.string().max(S2S_CLAIM_VALUE_MAX), z.number(), z.boolean()]);
export const S2sClaimsSchema = z
    .record(S2sClaimKeySchema, S2sClaimValueSchema)
    .refine((claims) => Object.keys(claims).length <= S2S_CLAIMS_MAX, `at most ${S2S_CLAIMS_MAX} claims`)
    .refine((claims) => utf8Length(JSON.stringify(claims)) <= S2S_CLAIMS_BYTES_MAX, `at most ${S2S_CLAIMS_BYTES_MAX} bytes of claims`)
    .describe("What the issuer says of the subject, by name: a word, a number or a yes/no each.");
export type S2sClaims = z.infer<typeof S2sClaimsSchema>;

const attestedSandbox = {
    sandbox: z.string().min(1).max(100).describe("Its sandbox id, as its own document names it."),
    address: S2sAddressSchema.describe("Where it was reached: its host or an own domain."),
    fingerprint: S2sFingerprintSchema.describe("Its key set's fingerprint when the attestation was made."),
};
const attestedAt = {
    issuedAt: z.number().int().nonnegative().describe("When it was made, in epoch milliseconds."),
    validUntil: z.number().int().nonnegative().describe("When it lapses, in epoch milliseconds: at most a year after `issuedAt`."),
};
export const S2sAttestationSubjectSchema = z.looseObject(attestedSandbox).describe("The sandbox it is about.");
export const S2sAttestationIssuerSchema = z
    .looseObject({
        ...attestedSandbox,
        // All four, not the signing pair alone: a key set's fingerprint is over all four, and the fingerprint is what a
        // reader trusts an issuer by.
        keys: S2sPublicKeysSchema.loose().describe("The issuer's public keys, which its fingerprint is over."),
        name: z.string().max(120).optional().describe("The issuer's display name, as its document gave it."),
    })
    .describe("The sandbox that vouches, with the keys its signature verifies under.");

const vouchFields = {
    v: z.literal(1),
    type: z.literal("sandbox-vouch"),
    issuer: S2sAttestationIssuerSchema,
    subject: S2sAttestationSubjectSchema,
    claims: S2sClaimsSchema,
    ...attestedAt,
    sig: HybridSigSchema.loose().describe("The issuer's signature over the canonical attestation without `sig`, signed for `attestation`."),
};
export const S2sSandboxVouchSchema = z
    .looseObject(vouchFields)
    .describe("Another sandbox's signed word about this one: who vouched, about which key, for what, until when.");
export type S2sSandboxVouch = z.infer<z.ZodObject<typeof vouchFields>>;

const eudiPidFields = {
    v: z.literal(1),
    type: z.literal("eudi-pid"),
    format: z.enum(["dc+sd-jwt", "mso_mdoc"]).describe("The credential's format, as OpenID for Verifiable Presentations names it."),
    presentation: z.string().min(1).max(8192).describe("The wallet's presentation, as it gave it."),
    subject: S2sAttestationSubjectSchema,
    ...attestedAt,
};
export const S2sEudiPidAttestationSchema = z
    .looseObject(eudiPidFields)
    .describe("Reserved: a person identification credential from an EU digital identity wallet. Parsed, never verified yet.");
export type S2sEudiPidAttestation = z.infer<z.ZodObject<typeof eudiPidFields>>;

export const S2sOtherAttestationSchema = z
    .looseObject({ type: z.string().min(1).max(64) })
    .describe("An attestation this build cannot read (a later type, or a known one it cannot parse), kept whole so the document carrying it still verifies.");
export type S2sOtherAttestation = z.infer<typeof S2sOtherAttestationSchema>;

// The first that parses: a vouch, the wallet slot, else anything with a type, kept as it came.
export const S2sAttestationSchema = z.union([S2sSandboxVouchSchema, S2sEudiPidAttestationSchema, S2sOtherAttestationSchema]);
export type S2sAttestation = S2sSandboxVouch | S2sEudiPidAttestation | S2sOtherAttestation;

// The public identity document, served at GET /s2s/identity.
const identityFields = {
    v: z.literal(1),
    sandbox: z.string().min(1).max(100).describe("The sandbox's own id."),
    name: z.string().max(120).describe("Its display name."),
    host: S2sAddressSchema.describe("Its current host, where /s2s/* answers."),
    domains: z.array(S2sDomainSchema).max(S2S_DOMAINS_MAX).describe("The own domains it verified (each with a matching TXT record), sorted."),
    keys: S2sPublicKeysSchema,
    fingerprint: S2sFingerprintSchema,
    recovery: S2sRecoveryFingerprintSchema.optional().describe("Its recovery key's fingerprint, when it made one."),
    protocols: z.array(z.string().min(1).max(40)).min(1).max(16).describe("The protocols it speaks: `s2s/1`."),
    issuedAt: z.number().int().nonnegative().describe("When this document was signed, in epoch milliseconds."),
    prev: S2sIdentityPrevSchema.optional(),
    attestations: z
        .array(S2sAttestationSchema)
        .max(S2S_ATTESTATIONS_MAX)
        .optional()
        .describe("What other sandboxes signed about this one, as it chose to publish them; absent when none. Each reader decides which issuers it trusts."),
    sig: HybridSigSchema.describe("Its own key set's signature over the canonical document without `sig`."),
};
// Loose on purpose: a later document may carry fields this build does not know, and its signature is over all of them,
// so none may be dropped on the way in. The type names only the fields this build knows.
export const SandboxIdentitySchema = z
    .looseObject(identityFields)
    .describe("A sandbox's signed public identity: who it is, where, and the keys every message to and from it uses.");
export type SandboxIdentity = z.infer<z.ZodObject<typeof identityFields>>;

// A domain's TXT record, parsed: `v=isk1 fp=<fingerprint> host=<host>`.
export const S2sTxtRecordSchema = z.object({
    fingerprint: S2sFingerprintSchema,
    host: S2sAddressSchema,
});
export type S2sTxtRecord = z.infer<typeof S2sTxtRecordSchema>;

/* GRANTS: what this sandbox lets a contact do here, decided here and only told to the other side. */

// The link terms a task grant carries (schemas/links.ts), the same fields under the same names with the same defaults,
// so an upgraded link keeps its terms exactly: `actsAs` is the role its tasks wear.
export const S2sTaskGrantSchema = LinkTermsSchema.pick({ actsAs: true, runAs: true, approve: true, turnsPerHour: true }).describe(
    "Tasks the contact may hand this sandbox: the role they wear (`actsAs`), whose authority they use (`runAs`), whether each waits for the owner, and how many turns an hour.",
);
export type S2sTaskGrant = z.infer<typeof S2sTaskGrantSchema>;

export const S2S_GRANT_KINDS = ["message", "report", "task", "records", "operate", "wake"] as const;
export const S2sGrantKindSchema = z.enum(S2S_GRANT_KINDS);
export type S2sGrantKind = z.infer<typeof S2sGrantKindSchema>;

export const S2sGrantsSchema = z
    .object({
        message: z.boolean().default(true).describe("Send messages here. On by default once accepted."),
        report: z.boolean().default(false).describe("Report problems into this sandbox's issues inbox."),
        task: S2sTaskGrantSchema.optional().describe("Hand this sandbox tasks, under these terms; absent, none."),
        records: z.boolean().default(false).describe("Read this sandbox's records (its conversations, logs and diagnostics) by call, read-only."),
        operate: z
            .boolean()
            .default(false)
            .describe("Run commands and read and write files here as the owner's own terminal does. Sandbox-scoped contacts only."),
        wake: z.boolean().default(false).describe("Hold this sandbox's wake secret, so a message to it starts it when it sleeps."),
    })
    .describe("What this sandbox lets a contact do here.");
export type S2sGrants = z.infer<typeof S2sGrantsSchema>;
export type S2sGrantsInput = z.input<typeof S2sGrantsSchema>;

// A change to the grants: whole fields replaced, the rest kept; `task: null` takes the task grant away.
export const S2sGrantsUpdateSchema = z.object({
    message: z.boolean().optional(),
    report: z.boolean().optional(),
    task: S2sTaskGrantSchema.nullable().optional(),
    records: z.boolean().optional(),
    operate: z.boolean().optional(),
    wake: z.boolean().optional(),
});
export type S2sGrantsUpdate = z.infer<typeof S2sGrantsUpdateSchema>;

/* CONTACTS: another sandbox this one knows, pinned to the key it showed. */

export const S2sPersonSchema = z.string().min(3).max(254).describe("A person, by the email this sandbox knows them by.");

export const S2sContactScopeSchema = z
    .discriminatedUnion("kind", [
        z.object({ kind: z.literal("sandbox") }),
        z.object({ kind: z.literal("person"), person: S2sPersonSchema }),
    ])
    .describe(
        "Who speaks over the contact: the sandbox as itself (made by its owner or a maintainer), or one person's route between two sandboxes they are in (made by their own press, used only for them, held to their floor on the receiving side).",
    );
export type S2sContactScope = z.infer<typeof S2sContactScopeSchema>;

export const S2sContactStateSchema = z
    .enum(["pending-out", "pending-in", "accepted", "key-changed", "blocked"])
    .describe(
        "pending-out: asked, waiting for their accept. pending-in: they asked, waiting for a person here. accepted: traffic flows. key-changed: their key changed with no proof; held both ways until a person presses Trust new key. blocked: refused, and nothing they send is kept.",
    );
export type S2sContactState = z.infer<typeof S2sContactStateSchema>;

export const S2sContactNoticeKindSchema = z
    .enum(["rotated", "recovered", "rekeyed-by-domain", "moved", "removed"])
    .describe(
        "rotated: a new key signed by the pinned one. recovered: a new key signed by the pinned recovery key. rekeyed-by-domain: a new key with no proof but its domain's TXT record (a warning). moved: a new address proven by the pinned key. removed: they removed this sandbox as a contact.",
    );
export type S2sContactNoticeKind = z.infer<typeof S2sContactNoticeKindSchema>;

export const S2sContactNoticeSchema = z.object({
    kind: S2sContactNoticeKindSchema,
    at: z.number().int().describe("When it was noticed, in epoch milliseconds."),
    from: z.string().max(260).optional().describe("What it was before: the earlier fingerprint, or the earlier address."),
    to: z.string().max(260).optional().describe("What it is now."),
    seen: z.boolean().default(false).describe("A person has read it."),
});
export type S2sContactNotice = z.infer<typeof S2sContactNoticeSchema>;

export const S2sContactOriginSchema = z
    .enum(["request", "paired", "link-upgrade", "pairing-upgrade", "report-bootstrap"])
    .describe(
        "How it was made: a handshake request (either side), an editor pairing, an upgraded link, an upgraded route pairing, or a first report's introduction.",
    );
export type S2sContactOrigin = z.infer<typeof S2sContactOriginSchema>;
