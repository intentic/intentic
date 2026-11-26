import { z } from "zod";

// (2026-11-26) WHAT A CARD'S OWN EXTENSION KNOWS ABOUT THE PLATFORM BEHIND IT, declared on the card so the core reads it
// in place of tables keyed by provider name: how long one message may be there, whether the extension publishes an
// approved post there itself and which targets it can address, what a publishing turn should know about posting there,
// and where the card sends people's data, for the Data protection page. Each fact is optional; a card that declares
// none is treated as before, with no known cap, posts published by a turn, and a connector's generic data path.

// The longest a `publish.target` pattern may be, and a sentence a publishing turn reads.
const PATTERN_MAX = 200;
const POSTING_MAX = 1_000;

// Whether `source` compiles as a JavaScript regular expression.
const compiles = (source: string): boolean => {
    try {
        return new RegExp(source, "u") instanceof RegExp;
    } catch {
        // allow(silent-catch): a pattern that does not compile is exactly what `false` reports
        return false;
    }
};

export const ChannelFactsSchema = z.object({
    messageLimit: z
        .number()
        .int()
        .min(1)
        .max(10_000_000)
        .optional()
        .describe(
            "The longest one message may be on this platform, in JavaScript string length (UTF-16 code units). The approvals inbox counts a post against it, and your own gateway splits a reply there. Absent: no known cap.",
        ),
    publish: z
        .object({
            target: z
                .string()
                .min(1)
                .max(PATTERN_MAX)
                .refine(compiles, { message: "publish.target must be a regular expression that compiles" })
                .describe(
                    'The targets your backend can address, as a regular expression a post\'s whole `target` must match (`^\\\\d{5,}$` for a channel id). A post with another target, or with attachments, goes to an agent turn instead.',
                ),
        })
        .optional()
        .describe(
            "Your backend publishes this platform's approved posts itself (`api.approvals.publish`), handed over by the approvals queue only after the person's yes was matched and spent, instead of an agent turn driving the logged-in browser. Needs `server`.",
        ),
    posting: z
        .string()
        .min(1)
        .max(POSTING_MAX)
        .optional()
        .describe(
            "What an agent turn publishing an approved post on this platform should know beyond its skill, said once in the turn's brief: how a reply nests, what a target means here.",
        ),
});
export type ChannelFacts = z.infer<typeof ChannelFactsSchema>;

// The data paths the Data protection page words (the contract's DATA_FLOW_KINDS a card can open): a team chat, mail read
// over IMAP, mail sent over SMTP, or any other connector.
export const PROCESSOR_FLOWS = ["team-chat", "email-imap", "email-smtp", "connector"] as const;
export type ProcessorFlow = (typeof PROCESSOR_FLOWS)[number];

export const ProcessorFactsSchema = z.object({
    flow: z
        .enum(PROCESSOR_FLOWS)
        .describe(
            "Which kind of path this is: `team-chat` (people's messages, both ways), `email-imap` (mail read from a server), `email-smtp` (mail sent through one), `connector` (whatever the agent chose to send).",
        ),
    operator: z.string().min(1).optional().describe("Who runs the service, as its terms name them (`Discord Inc.`). Absent: the office is asked."),
    region: z.string().min(1).optional().describe("Where the operator says it processes the data (`US`, `EU`, `EU/US`), only where it publishes one."),
    thirdCountry: z
        .boolean()
        .optional()
        .describe("True when the operator processes the data outside the European Economic Area, which makes this a transfer to a third country."),
    hosts: z
        .array(z.string().min(1))
        .optional()
        .describe("Every host data is sent to on this path, beyond the card's `hosts`: a realtime gateway, a file CDN."),
    hostField: z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9]*$/)
        .optional()
        .describe("The card's field naming the server this path reaches (an IMAP card's `host`). The path exists only once that field is filled in."),
});
export type ProcessorFacts = z.infer<typeof ProcessorFactsSchema>;

export const ProcessorsSchema = z
    .array(ProcessorFactsSchema)
    .min(1)
    .describe(
        "Where a card of this kind sends people's data, one entry per path out, for the Data protection page and the documents it drafts. Absent: one generic connector path over the card's `hosts`.",
    );

// (2026-11-26) A card whose state only its listener knows (a linked phone, a paired device): the card reads as connected
// only once its gateway reports the connection ready, and while it pairs it shows the code the gateway reports.
export const ListenerCardStatusSchema = z
    .object({
        from: z.literal("listener").describe("The card's status is whatever this extension's listener last reported for it."),
        pairingSteps: z
            .string()
            .min(1)
            .max(300)
            .optional()
            .describe('Where a person types the pairing code the listener reports, as the card says it: "Type this code <pairingSteps>."'),
    })
    .describe(
        "Take this card's status from your listener's report (`POST /listeners/<provider>/status`, its `connections` and `pairing`), for a card whose settings anyone could type but only the gateway knows whether they work.",
    );
export type ListenerCardStatus = z.infer<typeof ListenerCardStatusSchema>;
