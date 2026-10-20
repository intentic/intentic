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

// off: nothing is routed or read. watch: every shieldable turn is read on its way (the gateway, or a hooked runtime's
// channels), which records what it would have masked and sends everything unchanged. on: untrusted providers get
// tokens, and a turn that cannot be read by content at all (a runtime with no gateway and no hooks) is refused unless its
// provider is trusted.
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

// How a never-masked value (policy `allow`) is compared with what the shield finds, by the detectors and by the editor
// that keeps the list: case, Unicode composition and runs of whitespace do not tell two values apart.
export const allowKey = (value: string): string => value.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
export const PRIVACY_CONVERSATIONS_MAX = 200;

// The owner's own additions to what the shield finds. The policy travels whole on every write, so each is kept to what a
// person types or pastes; a dataset of thousands of values is taught to the vault instead (privacy learn).
export const PRIVACY_OWN_LISTS_MAX = 20;
export const PRIVACY_OWN_LIST_WORDS_MAX = 2000;
export const PRIVACY_WORD_MAX = 60;
export const PRIVACY_RULES_MAX = 50;
export const PRIVACY_RULE_TERMS_MAX = 1000;
export const PRIVACY_TERM_MAX = 200;
export const PRIVACY_PATTERN_MAX = 500;
export const PRIVACY_TITLE_MAX = 80;

// What a word on a name list says about a name: a first name or a surname (a name when the two stand together), a word
// that is a name only beside other evidence, a title after which a capitalized word is a person, or never part of one.
export const PrivacyNameListKindSchema = z.enum(["first-name", "surname", "ambiguous", "title", "never"]);
export type PrivacyNameListKind = z.infer<typeof PrivacyNameListKindSchema>;

// inflected: every Polish grammatical form of a listed word ("Kasia", "Kasi", "Kasię"); as-written: only as listed.
export const PrivacyNameMatchingSchema = z.enum(["inflected", "as-written"]);
export type PrivacyNameMatching = z.infer<typeof PrivacyNameMatchingSchema>;

// Ids the editor mints for the owner's lists and rules: stable across renames, so a write never confuses two of them.
const OwnIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/u);

export const PrivacyOwnNameListSchema = z.object({
    id: OwnIdSchema,
    title: z.string().min(1).max(PRIVACY_TITLE_MAX),
    kind: PrivacyNameListKindSchema,
    matching: PrivacyNameMatchingSchema.default("as-written"),
    words: z
        .array(z.string().min(1).max(PRIVACY_WORD_MAX))
        .max(PRIVACY_OWN_LIST_WORDS_MAX)
        .default([])
        .describe("One word each, in any case: the list is read as the built-in lists are."),
    on: z.boolean().default(true),
});
export type PrivacyOwnNameList = z.infer<typeof PrivacyOwnNameListSchema>;

export const PrivacyDictionaryPolicySchema = z.object({
    off: z.array(z.string().min(1).max(64)).max(64).default([]).describe("Built-in name lists switched off, by id (privacy.dictionary names them)."),
    lists: z
        .array(PrivacyOwnNameListSchema)
        .max(PRIVACY_OWN_LISTS_MAX)
        .default([])
        .describe("The owner's own name lists, read beside the built-in ones."),
});
export type PrivacyDictionaryPolicy = z.infer<typeof PrivacyDictionaryPolicySchema>;

// One of the owner's own rules: what it matches is masked wherever it stands, with no context asked for, as the kind it
// names. terms: each word or phrase as a whole word, in any case unless matchCase. pattern: a regular expression (with the
// `u` flag, `i` unless matchCase); a group named `value` masks only that part of a match.
export const PrivacyRuleMatchSchema = z.enum(["terms", "pattern"]);
export type PrivacyRuleMatch = z.infer<typeof PrivacyRuleMatchSchema>;

export const PrivacyRuleSchema = z.object({
    id: OwnIdSchema,
    title: z.string().min(1).max(PRIVACY_TITLE_MAX),
    on: z.boolean().default(true),
    class: PersonalDataClassSchema.describe("The kind what it matches is masked as; switching that kind off stops the rule too."),
    match: PrivacyRuleMatchSchema,
    terms: z.array(z.string().min(1).max(PRIVACY_TERM_MAX)).max(PRIVACY_RULE_TERMS_MAX).default([]),
    // Only its size is held here: whether a pattern is safe to run is judged when it is saved (patternProblem), so a
    // stored one never turns unreadable because a later build judges more strictly.
    pattern: z.string().max(PRIVACY_PATTERN_MAX).default(""),
    matchCase: z.boolean().default(false),
});
export type PrivacyRule = z.infer<typeof PrivacyRuleSchema>;

// Why a pattern cannot be saved. Owner-written patterns run on every string bound for an untrusted provider, in the
// daemon's one thread, so beside not compiling: one that matches empty text masks nothing and only costs, and a repeat
// inside a repeat (`(a+)+`, `(\w+\s?)*`) can take minutes on one line that almost matches.
export type PrivacyPatternProblem = "invalid" | "tooLong" | "empty" | "nested";

// The length of a quantifier at `at`, and whether it repeats a variable number of times (`*`, `+`, `{2,}`, `{2,5}`); `?`
// and `{3}` do not. A lazy `?` after it is part of it.
const quantifierAt = (source: string, at: number): { readonly length: number; readonly varies: boolean } | undefined => {
    const char = source[at];
    let length: number;
    let varies: boolean;
    if (char === "*" || char === "+" || char === "?") {
        length = 1;
        varies = char !== "?";
    } else if (char === "{") {
        const braces = /^\{(\d+)(?:(,)(\d*))?\}/u.exec(source.slice(at));
        if (braces === null) {
            return undefined;
        }
        const [whole, min = "0", comma, max] = braces;
        length = whole.length;
        varies = comma !== undefined && (max === undefined || max === "" || Number(max) > Number(min));
    } else {
        return undefined;
    }
    return { length: source[at + length] === "?" ? length + 1 : length, varies };
};

// One step of the walk below: where the next one starts, and what this one was.
interface PatternStep {
    readonly next: number;
    readonly kind: "open" | "close" | "repeat" | "other";
}

// Past a character class, escapes inside it included.
const classEnd = (source: string, at: number): number => {
    let end = at + 1;
    while (end < source.length && source[end] !== "]") {
        end += source[end] === "\\" ? 2 : 1;
    }
    return end + 1;
};

// Past a group's opening and its own prefix (`?:`, `?=`, `?<name>`), which is no quantifier.
const groupStart = (source: string, at: number): number => {
    if (source[at + 1] !== "?") {
        return at + 1;
    }
    const name = /^\?<(?![=!])[^>]*>/u.exec(source.slice(at + 1));
    return at + 1 + (name === null ? 2 : name[0].length);
};

const stepAt = (source: string, at: number): PatternStep => {
    const char = source[at];
    if (char === "\\") {
        return { next: at + 2, kind: "other" };
    }
    if (char === "[") {
        return { next: classEnd(source, at), kind: "other" };
    }
    if (char === "(") {
        return { next: groupStart(source, at), kind: "open" };
    }
    if (char === ")") {
        return { next: at + 1, kind: "close" };
    }
    const quantifier = quantifierAt(source, at);
    return quantifier === undefined
        ? { next: at + 1, kind: "other" }
        : { next: at + quantifier.length, kind: quantifier.varies ? "repeat" : "other" };
};

// Whether a group that repeats a variable number of times holds such a repeat itself: a star height above one.
const nestedRepeat = (source: string): boolean => {
    // Per open group, whether something inside it repeats.
    const open: boolean[] = [];
    // Whether the step before was the close of a group that held a repeat.
    let closedRepeating = false;
    for (let at = 0; at < source.length;) {
        const step = stepAt(source, at);
        at = step.next;
        if (step.kind === "open") {
            open.push(false);
        } else if (step.kind === "repeat") {
            if (closedRepeating) {
                return true;
            }
            open.fill(true);
        }
        closedRepeating = step.kind === "close" && (open.pop() ?? false);
    }
    return false;
};

export const patternProblem = (source: string): PrivacyPatternProblem | undefined => {
    if (source.length > PRIVACY_PATTERN_MAX) {
        return "tooLong";
    }
    let compiled: RegExp;
    try {
        compiled = new RegExp(source, "u");
    } catch {
        return "invalid";
    }
    if (source.trim() === "" || compiled.test("")) {
        return "empty";
    }
    return nestedRepeat(source) ? "nested" : undefined;
};

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
    dictionary: PrivacyDictionaryPolicySchema.default({ off: [], lists: [] }).describe(
        "The name dictionary as the owner adjusted it: built-in lists switched off, and lists of their own.",
    ),
    rules: z
        .array(PrivacyRuleSchema)
        .max(PRIVACY_RULES_MAX)
        .default([])
        .describe("The owner's own rules: words, phrases and patterns masked wherever they stand."),
});
export type PrivacyShieldPolicy = z.infer<typeof PrivacyShieldPolicySchema>;

// Whether the owner let this provider read this conversation as it is. A turn outside any conversation (a helper job)
// never is.
export const trustedInConversation = (
    policy: Pick<PrivacyShieldPolicy, "conversations">,
    provider: string,
    conversationId: string | undefined,
): boolean =>
    conversationId !== undefined && policy.conversations.some((entry) => entry.conversationId === conversationId && entry.provider === provider);

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
    shieldable: z
        .boolean()
        .describe(
            "The shield can read what its runtime sends by content (through the gateway or the runtime's hooks); one it cannot is refused while the shield is on, unless trusted.",
        ),
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
    imageId: z
        .string()
        .optional()
        .describe("The image it was painted over, as privacy.image reads it back: the picture before and after masking, while it is still kept."),
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

// One image the shield painted over, as it was and as it left: the owner peeking at what the provider saw. The picture
// before holds the personal data, so it is kept beside the vault, off the workspace, and only the owner may read it.
export const PRIVACY_IMAGE_ID = /^[A-Za-z0-9_-]{16,64}$/u;
export const PrivacyImageSchema = z.object({ mediaType: z.string(), data: z.string().describe("Base64.") });
export const PrivacyImagePairSchema = z.object({
    at: z.string().describe("When it was first painted, as an ISO timestamp."),
    before: PrivacyImageSchema,
    after: PrivacyImageSchema,
});
export type PrivacyImagePair = z.infer<typeof PrivacyImagePairSchema>;

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
// holds, how many, and where it came from; the owner's own lists among them.
export const PrivacyNameListSchema = z.object({
    id: z.string().describe("Stable id of the list."),
    kind: PrivacyNameListKindSchema.describe("What a word on it says about a name."),
    languages: z.array(z.enum(["pl", "en", "multi"])).describe("The languages its words come from; multi: many languages at once."),
    count: z.number().int().describe("How many words it holds."),
    matching: PrivacyNameMatchingSchema.describe(
        "inflected: matched in every grammatical form of a listed word; as-written: matched only exactly as listed.",
    ),
    source: z.string().describe("Where the words come from: the register or dataset, or that they were written by hand."),
    url: z.string().optional().describe("The source's page, where it has one."),
    license: z.string().optional(),
    on: z.boolean().describe("Read by the shield; the owner can switch any list off."),
    own: z.boolean().optional().describe("One of the owner's own lists (policy.dictionary.lists), titled by them."),
    title: z.string().optional().describe("An own list's title."),
});
export type PrivacyNameList = z.infer<typeof PrivacyNameListSchema>;

// What the lists say of one word.
export const PrivacyNameWordSchema = z.object({
    word: z.string(),
    firstName: z.boolean().describe("A listed first name, in this form or as an inflection of one."),
    surname: z.boolean().describe("A listed surname, in this form or as an inflection of one."),
    surnameForm: z.boolean().describe("Shaped like a Polish surname (-ski, -cki, -wicz…), listed or not."),
    ambiguous: z
        .boolean()
        .describe(
            "Also an ordinary word in some language, so found only beside other evidence (a title, a name field) and no surname to pair a first name with.",
        ),
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

// What the shield would mask in a text the owner tries it on, with the policy as saved: where each find sits, its kind,
// and what found it. Nothing is given a token and nothing is kept, so trying a value teaches the vault nothing.
export const PRIVACY_PREVIEW_MAX = 4000;

export const PrivacyPreviewSpanSchema = z.object({
    start: z.number().int(),
    end: z.number().int().describe("Exclusive."),
    class: PersonalDataClassSchema,
    by: z
        .enum(["detector", "rule", "learned", "model"])
        .describe(
            "detector: the built-in detectors and name lists, the owner's lists included; rule: one of the owner's rules; learned: a value the vault knows; model: the local name model.",
        ),
    rule: z.string().optional().describe("The id of the owner's rule that found it."),
});
export type PrivacyPreviewSpan = z.infer<typeof PrivacyPreviewSpanSchema>;

export const PrivacyPreviewSchema = z.object({ spans: z.array(PrivacyPreviewSpanSchema) });
export type PrivacyPreview = z.infer<typeof PrivacyPreviewSchema>;
