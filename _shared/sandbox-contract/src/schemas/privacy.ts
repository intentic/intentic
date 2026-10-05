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

// What an image bound for an untrusted provider becomes. mask: it is sent, with every stretch of its text the shield
// reads on this machine (OCR) and finds to be personal data painted over with that value's token; one that cannot be
// read is held back with a note, never sent unchecked. allow: sent as it is. (Before 2026-10, `withhold` sent a note
// in place of every image and `read` sent its masked text instead of the picture; both read as `mask` now.)
export const PrivacyImagesSchema = z.enum(["mask", "allow"]);
export type PrivacyImages = z.infer<typeof PrivacyImagesSchema>;

// How names are found. dictionary: the first-name and surname lists, with titles and inflection. model: those plus a
// local named-entity model, where one is installed; without it, the dictionary alone.
export const PrivacyNamesSchema = z.enum(["dictionary", "model"]);
export type PrivacyNames = z.infer<typeof PrivacyNamesSchema>;

export const PRIVACY_TRUSTED_MAX = 200;
export const PRIVACY_ALLOW_MAX = 1000;
export const PRIVACY_CONVERSATIONS_MAX = 200;

// One conversation the owner let an untrusted provider read as it is, granted from that conversation's own composer:
// narrower than the trusted list, and the way on for a provider whose runtime the gateway cannot sit in front of
// (Cursor's own wire, an ACP agent, Pi), which the shield otherwise refuses outright.
export const PrivacyConversationTrustSchema = z.object({
    conversationId: z.string().min(1).max(200),
    provider: z.string().min(1).max(200).describe("Provider id, as the trusted list names it."),
});
export type PrivacyConversationTrust = z.infer<typeof PrivacyConversationTrustSchema>;

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
    images: PrivacyImagesSchema.default("mask").describe("What an image bound for an untrusted provider becomes."),
    names: PrivacyNamesSchema.default("dictionary").describe("How names are found."),
    allow: z
        .array(z.string().min(1).max(200))
        .max(PRIVACY_ALLOW_MAX)
        .default([])
        .describe("Values never masked: your own company, a public figure, a word the detector keeps mistaking for a name."),
    conversations: z
        .array(PrivacyConversationTrustSchema)
        .max(PRIVACY_CONVERSATIONS_MAX)
        .default([])
        .describe("Providers that may read one conversation's personal data as it is, each granted from that conversation; oldest first."),
});
export type PrivacyShieldPolicy = z.infer<typeof PrivacyShieldPolicySchema>;

// Whether the owner let this provider read this conversation as it is. A turn outside any conversation (a helper job)
// never is.
export const trustedInConversation = (
    policy: Pick<PrivacyShieldPolicy, "conversations">,
    provider: string,
    conversationId: string | undefined,
): boolean => conversationId !== undefined && policy.conversations.some((entry) => entry.conversationId === conversationId && entry.provider === provider);

// The policy with that grant made or taken back. A full list drops its oldest grant to make room, since the newest is
// the one somebody is waiting on.
export const withConversationTrust = (policy: PrivacyShieldPolicy, conversationId: string, provider: string, on: boolean): PrivacyShieldPolicy => {
    const others = policy.conversations.filter((entry) => !(entry.conversationId === conversationId && entry.provider === provider));
    return { ...policy, conversations: on ? [...others, { conversationId, provider }].slice(-PRIVACY_CONVERSATIONS_MAX) : others };
};

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
        ocr: z.boolean().describe("The local text reader (PaddleOCR) that finds personal data in images is installed."),
        model: z.boolean().describe("A local named-entity model for names is installed."),
    }),
    providers: z.array(PrivacyProviderSchema),
});
export type PrivacyShieldStatus = z.infer<typeof PrivacyShieldStatusSchema>;

// One request the gateway handled, as the log keeps it: counts and kinds, the tokens it gave and the masked text around
// them, never a value.
export const PrivacyLedgerActionSchema = z.enum(["masked", "watched", "passed", "refused"]);
export type PrivacyLedgerAction = z.infer<typeof PrivacyLedgerActionSchema>;

// The most replacements one entry keeps, and how much masked text it keeps on each side of a token: enough to see what a
// value became and how the provider read it, not a second transcript.
export const PRIVACY_REPLACEMENTS_MAX = 12;
export const PRIVACY_EXCERPT_REACH = 48;

// One value the shield replaced in what a request added, as its token: the value itself stays in the vault, off the
// workspace, and only the owner can have it read back (privacy.reveal).
export const PrivacyReplacementSchema = z.object({
    token: z.string().describe("The token the value became, as the provider read it: Alice."),
    class: PersonalDataClassSchema,
    excerpt: z
        .string()
        .describe("The masked text around the token as it left this machine (watching: as it would have). Tokens only, never a value."),
    image: z.boolean().optional().describe("Found in an image's text, so the token was painted over the picture rather than written."),
});
export type PrivacyReplacement = z.infer<typeof PrivacyReplacementSchema>;

export const PrivacyLedgerEntrySchema = z.object({
    at: z.string().describe("When, as an ISO timestamp."),
    conversationId: z.string().optional(),
    provider: z.string(),
    trusted: z.boolean(),
    action: PrivacyLedgerActionSchema,
    counts: z.partialRecord(PersonalDataClassSchema, z.number().int()).describe("How many of each kind were found in what this request added."),
    images: z.number().int().describe("Images the shield changed: personal data painted over, or held back when they could not be read."),
    documents: z.number().int().describe("Documents replaced by their masked text."),
    protocol: z.string().describe("Which wire format the request spoke."),
    detail: z.string().optional().describe("Why it was refused, when it was."),
    replacements: z
        .array(PrivacyReplacementSchema)
        .max(PRIVACY_REPLACEMENTS_MAX)
        .optional()
        .describe("The first values replaced in what this request added, one per token. Absent on entries written before it was kept."),
});
export type PrivacyLedgerEntry = z.infer<typeof PrivacyLedgerEntrySchema>;

// Tokens read back to their values, for the owner checking what the shield masked; a token this vault never gave out is
// left out of the answer.
export const PRIVACY_REVEAL_MAX = 100;
export const PrivacyRevealSchema = z.object({ tokens: z.array(z.string().min(1).max(64)).max(PRIVACY_REVEAL_MAX) });

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

// The name lists the shield finds names by when no model is asked for (and alongside one when it is): what each list
// holds, how many, and where it came from.
export const PrivacyNameListSchema = z.object({
    id: z.string().describe("Stable id of the list."),
    kind: z.enum(["first-name", "surname", "ambiguous", "title", "never"]).describe("What a word on it says about a name."),
    languages: z.array(z.enum(["pl", "en"])).describe("The languages its words come from."),
    count: z.number().int().describe("How many words it holds."),
    matching: z
        .enum(["inflected", "as-written"])
        .describe("inflected: matched in every grammatical form of a listed word; as-written: matched only exactly as listed."),
    source: z.string().describe("Where the words come from: the register or dataset, or that they were written by hand."),
    url: z.string().optional().describe("The source's page, where it has one."),
    license: z.string().optional(),
});
export type PrivacyNameList = z.infer<typeof PrivacyNameListSchema>;

// What the lists say of one word.
export const PrivacyNameWordSchema = z.object({
    word: z.string(),
    firstName: z.boolean().describe("A listed first name, in this form or as an inflection of one."),
    surname: z.boolean().describe("A listed surname, in this form or as an inflection of one."),
    surnameForm: z.boolean().describe("Shaped like a Polish surname (-ski, -cki, -wicz…), listed or not."),
    ambiguous: z.boolean().describe("Also an ordinary word, so found only beside other evidence (a surname, a title)."),
    never: z.boolean().describe("Never taken as part of a name (a title, an institution, a function word)."),
});
export type PrivacyNameWord = z.infer<typeof PrivacyNameWordSchema>;

// What the dictionary makes of a word or a full name, for checking whether it would be found.
export const PrivacyNameLookupSchema = z.object({
    text: z.string().describe("The query as a name is written: each word capitalized."),
    found: z.boolean().describe("Whether the dictionary alone masks it as a name, written so on its own."),
    words: z.array(PrivacyNameWordSchema),
});
export type PrivacyNameLookup = z.infer<typeof PrivacyNameLookupSchema>;

export const PRIVACY_DICTIONARY_SAMPLE_MAX = 200;

export const PrivacyDictionarySchema = z.object({
    lists: z.array(PrivacyNameListSchema),
    totals: z
        .object({ firstNames: z.number().int(), surnames: z.number().int() })
        .describe("Distinct words across the first-name lists, and across the surname lists."),
    // Words of the lists that start with a one-word query, for browsing; empty without one.
    matches: z.array(z.object({ word: z.string(), lists: z.array(z.string()).describe("Ids of the lists holding it.") })),
    // The query read as a name, when there is one.
    lookup: PrivacyNameLookupSchema.optional(),
});
export type PrivacyDictionary = z.infer<typeof PrivacyDictionarySchema>;
