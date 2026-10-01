import { z } from "zod";
import { procedure } from "../protocol/route-meta.js";
import {
    PRIVACY_KNOWN_BATCH_MAX,
    PrivacyKnownSourceSchema,
    PrivacyKnownValueSchema,
    PrivacyLedgerEntrySchema,
    PrivacyShieldPolicySchema,
    PrivacyShieldStatusSchema,
} from "../schemas/privacy.js";
import { OkSchema } from "../schemas/shared.js";

// The privacy shield's policy, its log, and the datasets taught to it. The policy is the owner's alone: it is stored
// off the workspace (an agent could otherwise turn off the shield it is held to), and only the owner may change it.
// Teaching values only ever masks more, so the agent's CLI may do it; forgetting them is the owner's.
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
        .meta({ floor: "owner", control: "never", panel: false })
        .input(PrivacyShieldPolicySchema)
        .output(OkSchema),
    log: procedure
        .route({
            method: "GET",
            path: "/privacy/log",
            summary: "What the privacy shield did lately",
            description:
                "Each model request the gateway handled: which provider, whether it was trusted, and how many of each kind of personal data it found. Never the values.",
        })
        .output(z.array(PrivacyLedgerEntrySchema)),
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
        .meta({ agent: true })
        .input(
            z.object({
                source: z.string().min(1).max(200).describe("Where the values came from: a file and its column, a table."),
                values: z.array(PrivacyKnownValueSchema).max(PRIVACY_KNOWN_BATCH_MAX),
            }),
        )
        .output(z.object({ added: z.number().int(), known: z.number().int() })),
    forget: procedure
        .route({
            method: "POST",
            path: "/privacy/known/forget",
            summary: "Forget a taught dataset",
            description:
                "Stops matching the values taught from one source. Tokens already given to them still resolve, so earlier conversations keep reading right.",
        })
        .meta({ floor: "owner", control: "never", panel: false })
        .input(z.object({ source: z.string().min(1).max(200) }))
        .output(z.object({ forgotten: z.number().int() })),
};
