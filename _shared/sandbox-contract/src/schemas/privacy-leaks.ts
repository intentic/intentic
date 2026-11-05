// LEAKS AND HARDENING: personal data that reached an untrusted provider as it was, and the work of making the shield
// catch values like it. A leak is reported by a person ("this should have been masked") or suspected by a scan run on
// this machine over recent conversations; a confirmed leak's exact value is taught to the vault at once, so it is masked
// from then on, whoever asks. What a leak teaches beyond itself (a pattern for the form its kind takes here, a list of
// the surnames this sandbox's data holds) is the hardening session's: an agent reads each leak as its outline, measures a
// candidate rule against the leaks and against recent text on this machine, and proposes it; the owner applies it.
//
// An agent on a provider nobody trusted never reads a leak's value or the text around it: the text around a value can
// hold other values nobody reported, and the value itself is exactly what the shield did not recognise, so it would
// leave a second time. It reads the outline, the field label before it and what the name lists say of each word, and
// names a word it wants on a list by the leak it comes from (PrivacyLeakWordSchema), which the daemon resolves when the
// owner applies the proposal.

import { z } from "zod";
import {
    PersonalDataClassSchema,
    PrivacyNameListKindSchema,
    PrivacyNameMatchingSchema,
    PRIVACY_PATTERN_MAX,
    PRIVACY_RULE_TERMS_MAX,
    PRIVACY_TERM_MAX,
    PRIVACY_TITLE_MAX,
    PRIVACY_WORD_MAX,
    PrivacyRuleMatchSchema,
} from "./privacy.js";

export const PRIVACY_LEAKS_MAX = 500;
// How much text on each side of a leak is kept with it, for the owner and a trusted session to read it where it stood.
export const PRIVACY_LEAK_CONTEXT_REACH = 200;
export const PRIVACY_LEAK_VALUE_MAX = 500;
export const PRIVACY_PROPOSALS_MAX = 20;
// The most recent conversations a scan reads, and the default.
export const PRIVACY_SCAN_CONVERSATIONS_MAX = 100;
export const PRIVACY_SCAN_CONVERSATIONS_DEFAULT = 20;

// A leak's id as the daemon mints it: `L` and a number, never reused.
export const PRIVACY_LEAK_ID = /^L[1-9]\d{0,6}$/u;
export const PRIVACY_PROPOSAL_ID = /^P[1-9]\d{0,6}$/u;

// reported: a person (or an agent) said it should have been masked. scan: the local scan found it unmasked where the
// name model reads a name, or under a field whose label says what it holds.
export const PrivacyLeakOriginSchema = z.enum(["reported", "scan"]);
export type PrivacyLeakOrigin = z.infer<typeof PrivacyLeakOriginSchema>;

// suspected: a scan's find nobody has judged yet; nothing is taught. confirmed: personal data, taught to the vault.
// dismissed: not personal data; kept so the next scan does not suggest it again.
export const PrivacyLeakStateSchema = z.enum(["suspected", "confirmed", "dismissed"]);
export type PrivacyLeakState = z.infer<typeof PrivacyLeakStateSchema>;

// One leak as the daemon keeps it, off the workspace beside the vault: the value as it was written, and the text around it.
export const PrivacyLeakSchema = z.object({
    id: z.string().regex(PRIVACY_LEAK_ID),
    at: z.string().describe("When it was reported or found, as an ISO timestamp."),
    class: PersonalDataClassSchema,
    value: z.string().min(2).max(PRIVACY_LEAK_VALUE_MAX),
    context: z
        .string()
        .max(PRIVACY_LEAK_CONTEXT_REACH * 2 + PRIVACY_LEAK_VALUE_MAX)
        .default("")
        .describe("The text around the value as it was written, the value in it; empty when it was reported alone."),
    conversationId: z.string().max(200).optional(),
    origin: PrivacyLeakOriginSchema,
    state: PrivacyLeakStateSchema,
    why: z.string().max(200).optional().describe("Why a scan suspects it: the field label it stood under, or the name model."),
});
export type PrivacyLeak = z.infer<typeof PrivacyLeakSchema>;

// What the name lists say of one word of a leak, for a session that may not read the word.
export const PrivacyLeakWordFactsSchema = z.object({
    outline: z.string().describe("The word with each capital as A, small letter as a, digit as 9; anything else as it is."),
    firstName: z.boolean(),
    surname: z.boolean(),
    surnameForm: z.boolean().describe("Shaped like a Polish surname (-ski, -cki, -wicz…)."),
    ambiguous: z.boolean().describe("Also an ordinary word in some language."),
    never: z.boolean(),
});
export type PrivacyLeakWordFacts = z.infer<typeof PrivacyLeakWordFactsSchema>;

// What finds a leak now, without the vault's exact copy of it: the question hardening answers.
export const PrivacyLeakCaughtSchema = z.enum(["rule", "detector", "model", "no"]);
export type PrivacyLeakCaught = z.infer<typeof PrivacyLeakCaughtSchema>;

// A leak as a reader is shown it: always its outline, the label before it and what the lists say of its words; its value
// and the text around it only for someone who may read them (`revealed` on the view).
export const PrivacyLeakViewSchema = z.object({
    id: z.string(),
    at: z.string(),
    class: PersonalDataClassSchema,
    origin: PrivacyLeakOriginSchema,
    state: PrivacyLeakStateSchema,
    why: z.string().optional(),
    conversationId: z.string().optional(),
    outline: z.string().describe("The value with each capital as A, small letter as a, digit as 9; separators as they are."),
    length: z.number().int(),
    label: z
        .string()
        .optional()
        .describe("Up to four words just before the value on its line or in the cell before it (a field's label: `Nr paszportu`), each word that could be a name or holds a digit written as its outline."),
    words: z.array(PrivacyLeakWordFactsSchema).describe("Each word of the value, in order: what a list proposal names by its position."),
    caught: PrivacyLeakCaughtSchema.describe("What finds it now with the policy as saved, its exact copy in the vault set aside."),
    value: z.string().optional().describe("Only for someone who may read it."),
    context: z.string().optional().describe("Only for someone who may read it."),
});
export type PrivacyLeakView = z.infer<typeof PrivacyLeakViewSchema>;

// One word of a leak's value, by its position (0 is the first): how a session that never read the value puts it on a list.
export const PrivacyLeakWordSchema = z.object({
    leak: z.string().regex(PRIVACY_LEAK_ID),
    word: z.number().int().min(0).max(20),
});
export type PrivacyLeakWord = z.infer<typeof PrivacyLeakWordSchema>;

// A rule a session proposes: the owner's rule without its id and switch, which applying mints and turns on.
export const PrivacyProposedRuleSchema = z.object({
    title: z.string().min(1).max(PRIVACY_TITLE_MAX),
    class: PersonalDataClassSchema,
    match: PrivacyRuleMatchSchema,
    terms: z.array(z.string().min(1).max(PRIVACY_TERM_MAX)).max(PRIVACY_RULE_TERMS_MAX).default([]),
    pattern: z.string().max(PRIVACY_PATTERN_MAX).default(""),
    matchCase: z.boolean().default(false),
});
export type PrivacyProposedRule = z.infer<typeof PrivacyProposedRuleSchema>;

// Words for a name list a session proposes: written out, or named by the leak they come from. Applied onto the owner's
// own list of the same title and kind when there is one, else as a new list.
export const PrivacyProposedListSchema = z.object({
    title: z.string().min(1).max(PRIVACY_TITLE_MAX),
    kind: PrivacyNameListKindSchema,
    matching: PrivacyNameMatchingSchema.default("inflected"),
    words: z.array(z.string().min(1).max(PRIVACY_WORD_MAX)).max(500).default([]),
    fromLeaks: z.array(PrivacyLeakWordSchema).max(500).default([]),
});
export type PrivacyProposedList = z.infer<typeof PrivacyProposedListSchema>;

// What a session measures and proposes: rules and name-list words added to the policy as saved.
export const PrivacyHardeningSchema = z.object({
    rules: z.array(PrivacyProposedRuleSchema).max(20).default([]),
    lists: z.array(PrivacyProposedListSchema).max(10).default([]),
});
export type PrivacyHardening = z.infer<typeof PrivacyHardeningSchema>;

// One value the additions would mask in recent text that nothing masks today: a false positive to look at, or one more leak.
export const PrivacyHardeningSampleSchema = z.object({
    class: PersonalDataClassSchema,
    outline: z.string(),
    label: z.string().optional(),
    value: z.string().optional().describe("Only for someone who may read it."),
});
export type PrivacyHardeningSample = z.infer<typeof PrivacyHardeningSampleSchema>;

// What the additions do, measured on this machine: against the confirmed leaks, and against recent conversations.
export const PrivacyHardeningMeasureSchema = z.object({
    leaks: z.object({
        total: z.number().int().describe("Confirmed leaks measured against."),
        before: z.number().int().describe("Caught by the policy as saved, without the vault's exact copies."),
        after: z.number().int().describe("Caught with the additions."),
        missed: z.array(z.string()).describe("Ids of the confirmed leaks still not caught."),
    }),
    control: z.object({
        conversations: z.number().int(),
        chars: z.number().int(),
        added: z.number().int().describe("Values the additions would mask there that nothing masks today, the leaks themselves left out."),
        samples: z.array(PrivacyHardeningSampleSchema).max(12),
    }),
    problems: z.array(z.string()).describe("Rules that cannot be saved as written, each with why."),
});
export type PrivacyHardeningMeasure = z.infer<typeof PrivacyHardeningMeasureSchema>;

// A session's proposal, waiting for the owner: what to add, why, and what it measured when proposed.
export const PrivacyProposalSchema = z.object({
    id: z.string().regex(PRIVACY_PROPOSAL_ID),
    at: z.string(),
    conversationId: z.string().max(200).optional(),
    title: z.string().min(1).max(PRIVACY_TITLE_MAX),
    why: z.string().max(2000).default(""),
    hardening: PrivacyHardeningSchema,
    measured: PrivacyHardeningMeasureSchema,
});
export type PrivacyProposal = z.infer<typeof PrivacyProposalSchema>;

// The leaks, the proposals and the session working on them, as one reader is shown them.
export const PrivacyLeaksSchema = z.object({
    leaks: z.array(PrivacyLeakViewSchema),
    proposals: z.array(PrivacyProposalSchema),
    // The proposals' leak words as the reader may read them, by `L3:1`; empty for one who may not.
    words: z.record(z.string(), z.string()),
    revealed: z.boolean().describe("Whether this reader is shown values: a person who runs the shield, or a session on a trusted or local provider."),
    session: z
        .object({ conversationId: z.string(), at: z.string() })
        .optional()
        .describe("The hardening session last started from the page."),
});
export type PrivacyLeaks = z.infer<typeof PrivacyLeaksSchema>;

export const PrivacyLeakReportSchema = z.object({
    value: z.string().trim().min(2).max(PRIVACY_LEAK_VALUE_MAX),
    class: PersonalDataClassSchema,
    context: z.string().max(20_000).optional().describe("The text it stood in; the daemon keeps the stretch around the value."),
    conversationId: z.string().max(200).optional(),
});
export type PrivacyLeakReport = z.infer<typeof PrivacyLeakReportSchema>;

// The vault source a confirmed leak's exact value is taught under: one per leak, so dismissing one forgets that value
// alone. The privacy page lists these with the leaks, not with the datasets.
export const PRIVACY_LEAK_SOURCE_PREFIX = "leak:";
export const leakSource = (id: string): string => `${PRIVACY_LEAK_SOURCE_PREFIX}${id}`;

// How a leak's words are named in `PrivacyLeaks.words`.
export const leakWordKey = (word: { readonly leak: string; readonly word: number }): string => `${word.leak}:${String(word.word)}`;

// A value's words, as a list proposal counts them.
export const leakWordsOf = (value: string): string[] => value.split(/[\s,;|]+/u).filter((word) => word !== "");
