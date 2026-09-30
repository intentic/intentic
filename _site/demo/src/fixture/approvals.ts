import type { ApprovalSummary } from "@intentic/sandbox-contract";

// What the demo's agents prepared and may not do unasked (the Approvals queue, .intentic/config/approvals/): a launch
// post and an action, so Needs you shows an extension's asks beside the agents' own needs and the Approvals page has a
// queue to draw. Answers move this store, as the daemon's files would.

const minutes = (count: number): number => count * 60_000;

// The daemon's own hold on a yes: approving schedules the item a minute out, which the page counts down.
const HOLD_MS = 60_000;

const seed = (now: number): ApprovalSummary[] => [
    {
        id: `appr-launch-post`,
        kind: `post`,
        platform: `x`,
        content: `Checkout is live on the pricing page: pick a plan, pay with Stripe, and you're in. No sales call, no waiting list.\n\nTry it on the Team plan today.`,
        status: `proposed`,
        createdAt: now - minutes(14),
    },
    {
        id: `appr-refund-1182`,
        kind: `action`,
        summary: `Refund the duplicate charge on order 1182`,
        details: `The customer was charged twice for the Team plan on the same card, 40 seconds apart. Refund the second charge (**$40.00**, \`ch_3Q…8f2\`) in Stripe and reply on the support thread.`,
        instructions: `Refund charge ch_3Q8f2 on order 1182 in Stripe, then reply on the support thread that the refund is on its way.`,
        actsAs: `billing`,
        status: `proposed`,
        createdAt: now - minutes(32),
    },
];

let approvals: ApprovalSummary[] | undefined;

export const demoApprovals = (): readonly ApprovalSummary[] => {
    approvals ??= seed(Date.now());
    return approvals;
};

// Upsert by id, as the daemon writes the file; a yes with no date starts the hold.
export const upsertDemoApproval = (item: ApprovalSummary): void => {
    const held: ApprovalSummary = item.status === `approved` && item.scheduledAt === undefined ? { ...item, scheduledAt: Date.now() + HOLD_MS } : item;
    const current = demoApprovals();
    approvals = current.some((existing) => existing.id === item.id) ? current.map((existing) => (existing.id === item.id ? held : existing)) : [...current, held];
};

export const removeDemoApproval = (id: string): void => {
    approvals = demoApprovals().filter((existing) => existing.id !== id);
};
