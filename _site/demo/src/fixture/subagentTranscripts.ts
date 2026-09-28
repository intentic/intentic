import type { SandboxHandlerOutput, TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";

// What the checkout agent's in-process subagents (fleet.ts `inProcessSubagents`) said and did, as
// /agents/{id}/subagents/{subagentId}/transcript answers for them: the Explore run still searching, its prose so far, and
// the Plan run settled on its report. Anything else answers empty, honestly: nothing recorded.

const call = (id: string, name: string, category: TranscriptTool[`category`], target: string, text?: string): TranscriptTool => ({
    id,
    name,
    category,
    status: `completed`,
    target,
    ...(text === undefined ? {} : { content: [{ type: `text`, text }] }),
});

const EXPLORE: TranscriptRow[] = [
    {
        role: `user`,
        text: `Find every caller of createCheckoutSession across api/ and web/. For each, give file:line and say how it handles a failed session (a thrown error, a Stripe decline, a timeout).`,
    },
    {
        role: `assistant`,
        text: `Starting from the definition, then every import of it.`,
        tools: [
            call(
                `toolu_x1`,
                `Grep`,
                `search`,
                `createCheckoutSession`,
                `api/src/billing/checkout.ts:14\napi/src/routes/checkout.ts:3\napi/src/routes/checkout.ts:27\nweb/src/pricing/CheckoutPanel.tsx:9`,
            ),
            call(`toolu_x2`, `Read`, `read`, `api/src/billing/checkout.ts`),
        ],
    },
    {
        role: `assistant`,
        text: `The definition throws \`NotImplemented\` today, so the route's only failure path is that throw. Reading the route and the panel next.`,
        tools: [
            call(`toolu_x3`, `Read`, `read`, `api/src/routes/checkout.ts`),
            call(`toolu_x4`, `Read`, `read`, `web/src/pricing/CheckoutPanel.tsx`),
            {
                id: `toolu_x5`,
                name: `Grep`,
                category: `search`,
                status: `in_progress`,
                target: `checkout/session`,
            },
        ],
    },
];

const PLAN: TranscriptRow[] = [
    {
        role: `user`,
        text: `Plan the retry policy for Stripe webhooks: which failures retry, how often, and what happens to an event that never succeeds.`,
    },
    {
        role: `assistant`,
        text: `Reading how the webhook handler acknowledges events today.`,
        tools: [
            call(`toolu_p1`, `Read`, `read`, `api/src/webhooks/stripe.ts`),
            call(`toolu_p2`, `Grep`, `search`, `constructEvent`, `api/src/webhooks/stripe.ts:22`),
            call(`toolu_p3`, `Read`, `read`, `api/src/jobs/queue.ts`),
        ],
    },
    {
        role: `assistant`,
        text: [
            `**Retry policy**`,
            ``,
            `1. Retry on a 5xx from our own handler and on a timeout; never on a signature failure, which will fail the same way every time.`,
            `2. Back off exponentially from 30 seconds, doubling, and stop after five attempts.`,
            `3. After the fifth, move the event to the \`webhook_dead_letters\` table with the last error, so a person can replay it from the admin page.`,
            ``,
            `Stripe already retries on its side for three days, so ours only covers what happens after we have acknowledged the event.`,
        ].join(`\n`),
    },
];

const SUBAGENT_TRANSCRIPTS: Readonly<Record<string, TranscriptRow[]>> = {
    toolu_01explore8k2m: EXPLORE,
    toolu_01plan4x7c: PLAN,
};

export const subagentTranscriptFor = (subagentId: string): SandboxHandlerOutput<`agents`, `subagentTranscript`> => ({
    messages: SUBAGENT_TRANSCRIPTS[subagentId] ?? [],
});
