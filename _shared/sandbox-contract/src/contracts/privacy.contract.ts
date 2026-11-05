import { z } from "zod";
import { procedure } from "../protocol/route-meta.js";
import {
    PRIVACY_KNOWN_BATCH_MAX,
    PRIVACY_IMAGE_ID,
    PrivacyDictionarySchema,
    PrivacyImagePairSchema,
    PrivacyKnownSourceSchema,
    PrivacyKnownValueSchema,
    PrivacyLedgerEntrySchema,
    PRIVACY_PREVIEW_MAX,
    PrivacyPreviewSchema,
    PrivacyRevealSchema,
    PrivacyShieldPolicySchema,
    PrivacyShieldStatusSchema,
} from "../schemas/privacy.js";
import {
    PRIVACY_LEAK_ID,
    PRIVACY_PROPOSAL_ID,
    PRIVACY_SCAN_CONVERSATIONS_MAX,
    PrivacyHardeningMeasureSchema,
    PrivacyHardeningSchema,
    PrivacyLeakReportSchema,
    PrivacyLeaksSchema,
} from "../schemas/privacy-leaks.js";
import { OkSchema } from "../schemas/shared.js";

// The privacy shield's policy, its log, and the datasets taught to it. The policy is stored off the workspace (an agent
// could otherwise turn off the shield it is held to), and only a person changes it: the owner, Full access, or someone
// given the Privacy shield (members.ts `ManageRightSchema`), who also read masked values back. Teaching values only ever
// masks more, so the agent's CLI may do it; forgetting them is a person's call too.
export const privacyContract = {
    status: procedure
        .route({
            method: "GET",
            path: "/privacy/shield",
            summary: "The privacy shield and what it covers",
            description:
                "Whether personal data is kept from untrusted model providers, which providers are trusted, which local readers are installed, and how many values it has learned.",
        })
        .meta({ agent: true })
        .output(PrivacyShieldStatusSchema),
    setPolicy: procedure
        .route({
            method: "POST",
            path: "/privacy/shield",
            summary: "Change the privacy shield",
            description:
                "Replaces the policy whole. Turning the shield on puts every turn that starts from then on, whose runtime can be shielded, behind the gateway, and refuses the turns that cannot be shielded on an untrusted provider; a turn already running keeps the route it started with. A change to what is masked or trusted holds from the next model request.",
        })
        .meta({ floor: "maintainer", right: "privacy", control: "never", panel: false })
        .input(PrivacyShieldPolicySchema)
        .output(OkSchema),
    log: procedure
        .route({
            method: "GET",
            path: "/privacy/log",
            summary: "What the privacy shield did lately",
            description:
                "Each model request the gateway handled: which provider, whether it was trusted, how many of each kind of personal data it found, and the tokens it gave with the masked text around them. Never the values.",
        })
        .output(z.array(PrivacyLedgerEntrySchema)),
    reveal: procedure
        .route({
            method: "POST",
            path: "/privacy/reveal",
            summary: "Read tokens back to their values",
            description:
                "The value each token stands for, from the vault, so the owner can check what the shield masked and spot a value it should have left alone. Only the owner may ask; a token the vault never gave out is left out.",
        })
        .meta({ floor: "maintainer", right: "privacy", control: "never", panel: false })
        .input(PrivacyRevealSchema)
        .output(z.record(z.string(), z.string())),
    image: procedure
        .route({
            method: "POST",
            path: "/privacy/image",
            summary: "An image before and after masking",
            description:
                "The picture as it was and as the shield painted it before it left, for a log entry's image replacement. The picture before holds the personal data, so only the owner may ask. Only the most recent images are kept; an older one answers not found.",
        })
        .meta({ floor: "maintainer", right: "privacy", control: "never", panel: false })
        .input(z.object({ id: z.string().regex(PRIVACY_IMAGE_ID) }))
        .output(PrivacyImagePairSchema),
    dictionary: procedure
        .route({
            method: "GET",
            path: "/privacy/dictionary",
            summary: "The name lists the shield finds names by",
            description:
                "Every list the dictionary holds (first names, surnames, words that are names only beside other evidence, titles), the owner's own lists among them, whether each is switched on, how many words each has and where they come from. With a query, what the dictionary as the owner set it makes of it as a name, and for one word the listed words starting with it.",
        })
        .meta({ agent: true })
        .input(z.object({ query: z.string().max(100).optional().describe("A word, the start of one, or a full name.") }))
        .output(PrivacyDictionarySchema),
    preview: procedure
        .route({
            method: "POST",
            path: "/privacy/preview",
            summary: "Try the shield on a text",
            description:
                "What the shield would mask in the text with the policy as saved (every detector, the name lists, the owner's own rules, the values the vault knows) and what found each. Nothing is given a token or kept, whatever the switch says.",
        })
        .meta({ right: "privacy" })
        .input(z.object({ text: z.string().max(PRIVACY_PREVIEW_MAX) }))
        .output(PrivacyPreviewSchema),
    sources: procedure
        .route({
            method: "GET",
            path: "/privacy/known",
            summary: "The datasets taught to the shield",
            description: "Each source values were taught from, and how many. The values themselves are never sent back.",
        })
        .meta({ agent: true })
        .output(z.array(PrivacyKnownSourceSchema)),
    learn: procedure
        .route({
            method: "POST",
            path: "/privacy/known",
            summary: "Teach the shield a dataset's values",
            description:
                "Each value is masked wherever it appears from now on, in every form it is written, whether or not the detectors would have found it. Teaching only ever masks more, so the agent may do it.",
        })
        .meta({ agent: true, right: "privacy" })
        .input(
            z.object({
                source: z.string().min(1).max(200).describe("Where the values came from: a file and its column, a table."),
                values: z.array(PrivacyKnownValueSchema).max(PRIVACY_KNOWN_BATCH_MAX),
            }),
        )
        .output(z.object({ added: z.number().int(), known: z.number().int() })),
    // Leaks and hardening (schemas/privacy-leaks.ts). Reporting, scanning, measuring and proposing only ever lead to masking
    // more, so the agent's CLI may do them; judging a leak, applying a proposal and dismissing one are the owner's.
    leaks: procedure
        .route({
            method: "GET",
            path: "/privacy/leaks",
            summary: "Personal data that reached a provider unmasked, and the proposals to catch more like it",
            description:
                "Every reported or suspected leak with its outline, the field label before it, what the name lists say of its words and what finds it now without its exact copy in the vault; and the hardening proposals waiting for the owner. Values and the text around them only for a person who runs the shield, or an agent whose conversation runs on a trusted or local provider.",
        })
        // Values ride this read for a person, so it floors where the policy does rather than at a read's viewer.
        .meta({ floor: "maintainer", agent: true, right: "privacy" })
        .output(PrivacyLeaksSchema),
    report: procedure
        .route({
            method: "POST",
            path: "/privacy/leaks",
            summary: "Report a value the shield should have masked",
            description:
                "Kept as a confirmed leak, and its exact value taught to the vault: masked wherever it appears from now on. Reporting only ever masks more, so the agent may do it.",
        })
        .meta({ agent: true, right: "privacy" })
        .input(PrivacyLeakReportSchema)
        .output(z.object({ id: z.string() })),
    judge: procedure
        .route({
            method: "POST",
            path: "/privacy/leaks/judge",
            summary: "Confirm or dismiss a leak",
            description:
                "Confirming teaches its exact value to the vault, so it is masked from now on. Dismissing says it is no personal data: a value taught for it is forgotten, and a scan does not suggest it again.",
        })
        .meta({ floor: "maintainer", right: "privacy", control: "never", panel: false })
        .input(z.object({ id: z.string().regex(PRIVACY_LEAK_ID), state: z.enum(["confirmed", "dismissed"]) }))
        .output(OkSchema),
    scan: procedure
        .route({
            method: "POST",
            path: "/privacy/leaks/scan",
            summary: "Look for leaks in recent conversations, on this machine",
            description:
                "Reads the most recent conversations here and suspects every value nothing masks that the local name model reads as a name, or that stands under a field labelled as personal data (PESEL, passport, e-mail…). Nothing leaves this machine and nothing is taught: the owner confirms or dismisses each.",
        })
        .meta({ agent: true, right: "privacy" })
        .input(z.object({ conversations: z.number().int().min(1).max(PRIVACY_SCAN_CONVERSATIONS_MAX).optional() }))
        .output(z.object({ conversations: z.number().int(), chars: z.number().int(), suspected: z.number().int() })),
    tryHardening: procedure
        .route({
            method: "POST",
            path: "/privacy/leaks/try",
            summary: "Measure rules and name-list words before proposing them",
            description:
                "Adds them to the policy as saved and measures, on this machine: how many confirmed leaks they catch that nothing catches now, and what they would mask in recent conversations that nothing masks today, as outlines (values only for a reader who may read them). Nothing is saved.",
        })
        .meta({ agent: true, right: "privacy" })
        .input(PrivacyHardeningSchema)
        .output(PrivacyHardeningMeasureSchema),
    propose: procedure
        .route({
            method: "POST",
            path: "/privacy/proposals",
            summary: "Propose rules and name-list words to the owner",
            description:
                "Measured as tryHardening measures them, and kept for the owner, who applies or dismisses it on the privacy page. A rule whose pattern cannot be saved is refused here.",
        })
        .meta({ agent: true, right: "privacy" })
        .input(z.object({ title: z.string().min(1).max(80), why: z.string().max(2000).default(""), hardening: PrivacyHardeningSchema }))
        .output(z.object({ id: z.string(), measured: PrivacyHardeningMeasureSchema })),
    applyProposal: procedure
        .route({
            method: "POST",
            path: "/privacy/proposals/apply",
            summary: "Apply a hardening proposal to the policy",
            description:
                "Its rules are added and switched on, and its words go onto the owner's own list of the same title and kind, or a new one; a word named by its leak is read from that leak here.",
        })
        .meta({ floor: "maintainer", right: "privacy", control: "never", panel: false })
        .input(z.object({ id: z.string().regex(PRIVACY_PROPOSAL_ID) }))
        .output(OkSchema),
    dismissProposal: procedure
        .route({
            method: "POST",
            path: "/privacy/proposals/dismiss",
            summary: "Dismiss a hardening proposal",
        })
        .meta({ floor: "maintainer", right: "privacy", control: "never", panel: false })
        .input(z.object({ id: z.string().regex(PRIVACY_PROPOSAL_ID) }))
        .output(OkSchema),
    hardeningSession: procedure
        .route({
            method: "POST",
            path: "/privacy/leaks/session",
            summary: "Note the hardening session started from the page",
            description: "So the page offers to open it rather than starting a second one while it is still on the board.",
        })
        .meta({ right: "privacy", panel: false })
        .input(z.object({ conversationId: z.string().min(1).max(200) }))
        .output(OkSchema),
    forget: procedure
        .route({
            method: "POST",
            path: "/privacy/known/forget",
            summary: "Forget a taught dataset",
            description:
                "Stops matching the values taught from one source. Tokens already given to them still resolve, so earlier conversations keep reading right.",
        })
        .meta({ floor: "maintainer", right: "privacy", control: "never", panel: false })
        .input(z.object({ source: z.string().min(1).max(200) }))
        .output(z.object({ forgotten: z.number().int() })),
};
