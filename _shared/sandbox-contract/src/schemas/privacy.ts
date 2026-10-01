// The privacy shield: personal data (names, national ids, document numbers, accounts…) kept away from model providers
// the owner does not trust. The daemon puts a gateway between every runtime it can point at one and the provider, which
// replaces what it finds with stable tokens on the way out and puts the real values back on the way in, so the agent
// works on real data while an untrusted provider only ever reads tokens. Off unless the owner turns it on.

import { z } from "zod";

// What the shield looks for, one switch each. `known` values (a dataset the owner taught it) carry the class they were
// taught under, so there is no class of their own.
export const PERSONAL_DATA_CLASSES = [
    "person-name",
    "national-id",
    "tax-id",
    "identity-document",
    "bank-account",
    "payment-card",
    "email",
    "phone",
    "address",
] as const;
export const PersonalDataClassSchema = z.enum(PERSONAL_DATA_CLASSES);
export type PersonalDataClass = z.infer<typeof PersonalDataClassSchema>;

// off: nothing is routed or read. watch: every shieldable turn goes through the gateway, which reads and records what it
// would have masked and sends everything unchanged. on: untrusted providers get tokens, and a turn that cannot be
// shielded (a runtime the gateway cannot sit in front of) is refused unless its provider is trusted.
export const PrivacyShieldModeSchema = z.enum(["off", "watch", "on"]);
export type PrivacyShieldMode = z.infer<typeof PrivacyShieldModeSchema>;

// What an image bound for an untrusted provider becomes. withhold: a note saying it was held back. read: its text, read
// on this machine (OCR) and masked, in its place, or the note when no reader is installed. allow: sent as it is.
export const PrivacyImagesSchema = z.enum(["withhold", "read", "allow"]);
export type PrivacyImages = z.infer<typeof PrivacyImagesSchema>;

// How names are found. dictionary: the first-name and surname lists, with titles and inflection. model: those plus a
// local named-entity model, where one is installed; without it, the dictionary alone.
export const PrivacyNamesSchema = z.enum(["dictionary", "model"]);
export type PrivacyNames = z.infer<typeof PrivacyNamesSchema>;

export const PRIVACY_TRUSTED_MAX = 200;
export const PRIVACY_ALLOW_MAX = 1000;

export const PrivacyShieldPolicySchema = z.object({
    mode: PrivacyShieldModeSchema.default("off").describe("Whether the shield is off, only watching, or masking."),
    trusted: z
        .array(z.string().min(1).max(200))
        .max(PRIVACY_TRUSTED_MAX)
        .default([])
        .describe(
            "Providers that may read personal data as it is, by provider id (`claude`, `codex`, `endpoint/<id>`). A local model is always trusted.",
        ),
    classes: z
        .array(PersonalDataClassSchema)
        .default([...PERSONAL_DATA_CLASSES])
        .describe("Which kinds of personal data are looked for."),
    images: PrivacyImagesSchema.default("withhold").describe("What an image bound for an untrusted provider becomes."),
    names: PrivacyNamesSchema.default("dictionary").describe("How names are found."),
    allow: z
        .array(z.string().min(1).max(200))
        .max(PRIVACY_ALLOW_MAX)
        .default([])
        .describe("Values never masked: your own company, a public figure, a word the detector keeps mistaking for a name."),
});
export type PrivacyShieldPolicy = z.infer<typeof PrivacyShieldPolicySchema>;

// The policy a sandbox that never wrote one runs on.
export const DEFAULT_PRIVACY_SHIELD: PrivacyShieldPolicy = PrivacyShieldPolicySchema.parse({});

// How a provider stands against the gateway, for the trusted list: whether its traffic can be shielded at all, and
// whether it never leaves this machine.
export const PrivacyProviderSchema = z.object({
    id: z.string().describe("Provider id, as the trusted list names it."),
    label: z.string(),
    shieldable: z.boolean().describe("Its runtime can be put behind the gateway; one that cannot is refused while the shield is on, unless trusted."),
    local: z.boolean().describe("It runs on this machine, so it is trusted whatever the list says."),
});
export type PrivacyProvider = z.infer<typeof PrivacyProviderSchema>;

export const PrivacyShieldStatusSchema = z.object({
    policy: PrivacyShieldPolicySchema,
    known: z.number().int().describe("Values taught from your datasets, matched exactly wherever they appear."),
    tokens: z.number().int().describe("Values the shield has given a token so far."),
    readers: z.object({
        ocr: z.boolean().describe("A local text reader for images is installed."),
        model: z.boolean().describe("A local named-entity model for names is installed."),
    }),
    providers: z.array(PrivacyProviderSchema),
});
export type PrivacyShieldStatus = z.infer<typeof PrivacyShieldStatusSchema>;

// One request the gateway handled, as the log keeps it: counts and kinds, never a value.
export const PrivacyLedgerActionSchema = z.enum(["masked", "watched", "passed", "refused"]);
export type PrivacyLedgerAction = z.infer<typeof PrivacyLedgerActionSchema>;

export const PrivacyLedgerEntrySchema = z.object({
    at: z.string().describe("When, as an ISO timestamp."),
    conversationId: z.string().optional(),
    provider: z.string(),
    trusted: z.boolean(),
    action: PrivacyLedgerActionSchema,
    counts: z.partialRecord(PersonalDataClassSchema, z.number().int()).describe("How many of each kind were found in what this request added."),
    images: z.number().int().describe("Images withheld or replaced by their read text."),
    documents: z.number().int().describe("Documents replaced by their masked text."),
    protocol: z.string().describe("Which wire format the request spoke."),
    detail: z.string().optional().describe("Why it was refused, when it was."),
});
export type PrivacyLedgerEntry = z.infer<typeof PrivacyLedgerEntrySchema>;

// A dataset taught to the shield: each value is matched exactly from then on, in every form it is written.
export const PRIVACY_KNOWN_BATCH_MAX = 50_000;

export const PrivacyKnownValueSchema = z.object({
    value: z.string().min(2).max(500),
    class: PersonalDataClassSchema,
});
export type PrivacyKnownValue = z.infer<typeof PrivacyKnownValueSchema>;

export const PrivacyKnownSourceSchema = z.object({
    source: z.string().describe("Where the values came from, as whoever taught them named it."),
    count: z.number().int(),
    at: z.string().describe("When they were last taught."),
});
export type PrivacyKnownSource = z.infer<typeof PrivacyKnownSourceSchema>;
