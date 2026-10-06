import { STATE_DIR } from "@intentic/constants";
import { type AgentSummary, ciFixConversationId, nextDayStartIn, type SubagentSession, UTC } from "@intentic/sandbox-contract";
import { SUPPORT_SWEEP_PATH } from "./browserShots";

// One afternoon across two repos, with a card in every lane `laneOf` distinguishes: attention (awaiting a parked
// question, conflict from a land overlap), active (running, one delegating to subagents), finished (ready, landed,
// idle). Times are relative to page load. Three of them have spawned child agents (spawnedChildren, auditFamily), which
// the board hangs under their cards, moving a card to the lane its children need: Attention for an ask only the reader
// can answer, Active for work still in flight under a finished parent.

// Conversation id shared by the roster, transcript route and attach stream (turn.ts supplies the script).
export const FEATURED_AGENT_ID = `cnv_checkout_stripe`;
// Agent parked on a question: the fleet attention badge's reason to exist.
export const AWAITING_AGENT_ID = `cnv_flaky_signup`;
// Agent holding a finished delta: what the review panel opens on and demonstrates Land now with.
export const REVIEW_AGENT_ID = `cnv_soft_deletes`;
// Agent whose land refuses: half the delta diverged, half is held by the owner's own edits.
export const CONFLICT_AGENT_ID = `cnv_auth_middleware`;
// A second agent at work, on another provider: what the showcase mode adds to the curated three.
export const LATENCY_AGENT_ID = `cnv_latency_p99`;
// Work already landed, by the other person's hand: the showcase's second finished card.
export const RELEASE_NOTES_AGENT_ID = `cnv_release_notes`;
// A chat whose last message the sandbox turned away for low memory: the words wait in its queue, held for one press.
export const HELD_AGENT_ID = `cnv_support_card`;
// That message, as the queue holds it; its picture is the sweep capture the workspace carries (fixture/browserShots.ts).
export const HELD_MESSAGE_ID = `msg_01j9supportcard`;
// A conversation that has not started: its first message waits for the checkout agent's work to land, booked from the
// composer's Send later, and its own work lands by itself once it finishes.
export const SCHEDULED_AGENT_ID = `cnv_checkout_docs`;
export const SCHEDULED_MESSAGE_ID = `msg_01j9checkoutdocs`;
// The one fix agent the sandbox put on each failing main line (fixture/ci.ts), at the first failed job of the run that
// made it fail. Their ids are the daemon's own shape (ciFixConversationId): the repository, then that run's id, which a
// later failed run on the same branch does not share.
export const WEB_MAIN_FIXER_ID = ciFixConversationId(`web`, 4_818);
export const API_MAIN_FIXER_ID = ciFixConversationId(`api`, 90_314);

const minutes = (count: number): number => count * 60_000;

// Midnight on the daemon's UTC clock after `now`, when the date in an agent's prompt changes and its cache can no longer be kept.
const midnightAfter = (now: number): number => nextDayStartIn(now, UTC);

// Two commands the soft-deletes agent left running past their calls: one finished, one still going.
export const SOFT_TYPECHECK_JOB = `job_soft_typecheck`;
export const SOFT_E2E_JOB = `job_soft_e2e`;
export const SOFT_DELETES_JOBS = (now: number) =>
    [
        {
            id: SOFT_TYPECHECK_JOB,
            label: `Typecheck the web client against the new row`,
            command: `pnpm -C web exec vue-tsc --noEmit -p tsconfig.app.json`,
            session: `agent-ses01j9s`,
            startedAt: now - minutes(24),
            endedAt: now - minutes(24) + 52_000,
            exitCode: 0,
        },
        {
            id: SOFT_E2E_JOB,
            label: `Run the web e2e suite`,
            command: `pnpm -C web e2e --project=chromium --reporter=line`,
            session: `agent-ses01j9s`,
            startedAt: now - minutes(19),
        },
    ] as const;

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false } as const;

// A child another conversation spawned: its own branch and worktree like any agent, `startedBy` naming its parent, and
// the parent's owner and account inherited.
const spawned = (parent: string, id: string, over: Omit<Partial<AgentSummary>, `id`> & Pick<AgentSummary, `title` | `status` | `updatedAt`>): AgentSummary => ({
    id,
    startedBy: `agent:${parent}`,
    startIn: `web`,
    sessionId: `ses_${id}`,
    provider: `claude`,
    harness: `claude-code`,
    model: `claude-sonnet-5`,
    effort: `medium`,
    account: `acc_claude_demo`,
    branch: `agent/${id}`,
    base: `4f1c8ab`,
    attention: NO_ATTENTION,
    turns: 1,
    ...over,
});

// The checkout agent's helpers, one of each standing: two at work (one on another provider), two settled, and one parked
// on a permission, which carries the checkout card into Attention. Then the release notes' helpers: settled ones ride
// under its finished card, and the one still translating lifts that card into Active, since Finished is no place for
// work in flight.
const spawnedChildren = (now: number): AgentSummary[] => [
    spawned(FEATURED_AGENT_ID, `sub-brisk-otter-4k2m`, {
        title: `Write the webhook handler tests`,
        status: `running`,
        provider: `codex`,
        harness: `native`,
        model: `gpt-5.2-codex`,
        activity: { tool: `Bash`, target: `pnpm -C api test src/webhooks`, todo: `Cover the signature check` },
        startedAt: now - minutes(2),
        updatedAt: now - 1_200,
        costUsd: 0.05,
    }),
    spawned(FEATURED_AGENT_ID, `sub-calm-heron-8p1d`, {
        title: `Port the pricing copy to the new plans`,
        status: `running`,
        activity: { tool: `Edit`, target: `web/src/pricing/plans.ts`, todo: `Rename the Team tier` },
        startedAt: now - 42_000,
        updatedAt: now - 800,
        costUsd: 0.02,
    }),
    spawned(FEATURED_AGENT_ID, `sub-quiet-fern-2x7c`, {
        title: `Map the existing billing tables`,
        status: `idle`,
        updatedAt: now - minutes(3),
        seenAt: now - minutes(3),
        costUsd: 0.03,
    }),
    spawned(FEATURED_AGENT_ID, `sub-swift-lark-9q3e`, {
        title: `Add the Stripe SDK to web`,
        status: `landed`,
        updatedAt: now - minutes(6),
        seenAt: now - minutes(6),
        costUsd: 0.04,
        diff: { files: 2, insertions: 18, deletions: 2 },
    }),
    spawned(FEATURED_AGENT_ID, `sub-keen-moth-5r8t`, {
        title: `Rotate the Stripe test keys`,
        status: `awaiting`,
        attention: { ...NO_ATTENTION, permission: true },
        updatedAt: now - 20_000,
        seenAt: now - minutes(1),
        costUsd: 0.01,
    }),
    spawned(RELEASE_NOTES_AGENT_ID, `sub-soft-pine-1a2b`, {
        title: `Collect the merged PRs since 2.3`,
        status: `idle`,
        model: `claude-haiku-4-5-20251001`,
        updatedAt: now - minutes(41),
        seenAt: now - minutes(40),
    }),
    spawned(RELEASE_NOTES_AGENT_ID, `sub-bold-reef-3c4d`, {
        title: `Summarise the breaking changes`,
        status: `landed`,
        model: `claude-haiku-4-5-20251001`,
        updatedAt: now - minutes(37),
        seenAt: now - minutes(36),
        diff: { files: 1, insertions: 9, deletions: 0 },
    }),
    spawned(RELEASE_NOTES_AGENT_ID, `sub-warm-dune-6e7f`, {
        title: `Translate the release notes into German`,
        status: `running`,
        provider: `codex`,
        harness: `native`,
        model: `gpt-5.2-codex`,
        activity: { tool: `Edit`, target: `docs/releases/2.4.de.md`, todo: `Translate the upgrade steps` },
        startedAt: now - minutes(5),
        updatedAt: now - 2_100,
    }),
];

// What the checkout agent's own runtime ran in-process (its Agent tool) beside the conversations it spawned: no
// conversation of their own, so the roster names them, and the board deals them into the same tray as its spawned
// helpers, one still exploring and one whose plan came back.
export const inProcessSubagents = (now: number): SubagentSession[] => [
    {
        id: `toolu_01explore8k2m`,
        kind: `subagent`,
        conversationId: FEATURED_AGENT_ID,
        agentType: `Explore`,
        description: `Find every caller of createCheckoutSession`,
        model: `claude-sonnet-5`,
        effort: `low`,
        status: `running`,
        startedAt: now - minutes(1),
        activityAt: now - 3_000,
        lastTool: `Grep`,
        toolUses: 9,
    },
    {
        id: `toolu_01plan4x7c`,
        kind: `subagent`,
        conversationId: FEATURED_AGENT_ID,
        agentType: `Plan`,
        description: `Plan the webhook retry policy`,
        model: `claude-opus-5`,
        effort: `max`,
        status: `completed`,
        startedAt: now - minutes(9),
        endedAt: now - minutes(4),
        activityAt: now - minutes(4),
        toolUses: 14,
        summary: `Retry 5xx and timeouts with exponential backoff, cap at five attempts, and dead-letter the rest.`,
        verification: { state: `no-code` },
    },
];

// Epoch seconds, the unit a limit's reset travels in.
const seconds = (at: number): number => Math.round(at / 1000);

// An orchestrator fanned out over one batch each, as a test audit does: most of its Codex batches refused by the same
// spent allowance, two Gemini batches that never started, one still working and a few done. Every stop is its parent's
// news while it works, so the whole family is one card in Active with a tray of a handful of rows, not a dozen cards in
// Attention.
export const AUDIT_AGENT_ID = `cnv_test_audit`;
const auditFamily = (now: number): AgentSummary[] => {
    const resetsAt = seconds(now + minutes(21));
    const batch = (at: number): string => `Test audit, batch ${String(at).padStart(2, `0`)}`;
    const codex = { provider: `codex`, harness: `native`, model: `gpt-5.2-codex` } as const;
    return [
        {
            id: AUDIT_AGENT_ID,
            startIn: `web`,
            sessionId: `ses_01j9testaudit`,
            title: `Audit the test suite and prune the weakest tests`,
            status: `running`,
            provider: `claude`,
            harness: `claude-code`,
            model: `claude-opus-5`,
            effort: `high`,
            account: `acc_claude_demo`,
            branch: `agent/test-audit`,
            base: `4f1c8ab`,
            costUsd: 1.84,
            activity: { tool: `Bash`, target: `agents wait any`, todo: `Resume the Codex batches when the allowance reopens` },
            startedAt: now - minutes(38),
            updatedAt: now - 2_400,
            seenAt: now - minutes(30),
            attention: NO_ATTENTION,
            turns: 2,
            toolUses: 212,
            subagents: { running: 1, total: 12 },
        },
        spawned(AUDIT_AGENT_ID, `sub-lean-cedar-7h2k`, {
            title: batch(14),
            status: `running`,
            provider: `cursor`,
            harness: `native`,
            model: `composer-2.5`,
            activity: { tool: `Read`, target: `web/src/pricing/plans.test.ts`, todo: `Score each case against the rubric` },
            startedAt: now - minutes(6),
            updatedAt: now - 900,
        }),
        ...[3, 4, 5, 6, 7, 8].map((at, index) =>
            spawned(AUDIT_AGENT_ID, `sub-codex-batch-${at}`, {
                ...codex,
                title: batch(at),
                status: `error`,
                failureCode: `rate_limit`,
                failure: `exceeded retry limit, last status: 429 Too Many Requests`,
                limitResetsAt: resetsAt,
                limitHeld: true,
                updatedAt: now - minutes(9) - index * 20_000,
                seenAt: now - minutes(12),
            }),
        ),
        ...[11, 12].map((at, index) =>
            spawned(AUDIT_AGENT_ID, `sub-gemini-batch-${at}`, {
                provider: `gemini`,
                harness: `native`,
                model: `gemini-3-pro`,
                title: batch(at),
                status: `error`,
                failure: `Verify your account to continue.`,
                updatedAt: now - minutes(11) - index * 15_000,
                seenAt: now - minutes(12),
            }),
        ),
        ...[1, 2, 9].map((at, index) =>
            spawned(AUDIT_AGENT_ID, `sub-done-batch-${at}`, {
                ...codex,
                title: batch(at),
                status: `landed`,
                updatedAt: now - minutes(20) - index * minutes(2),
                seenAt: now - minutes(20) - index * minutes(2),
                costUsd: 0.12,
            }),
        ),
    ];
};

// The two people on this demo sandbox, the same pair the presence roster draws (daemon.ts): the reader is Ada, so a
// chip carrying her reads as one of her own and a chip carrying only Grace is one to press.
const ADA = { email: `ada@acme.dev`, name: `Ada Lovelace` };
const GRACE = { email: `grace@acme.dev`, name: `Grace Hopper` };

export const fleetRoster = (now: number): AgentSummary[] => [
    {
        id: FEATURED_AGENT_ID,
        startIn: `web`,
        sessionId: `ses_01j9checkout`,
        title: `Add Stripe checkout to the pricing page`,
        status: `running`,
        provider: `claude`,
        harness: `claude-code`,
        model: `claude-sonnet-5`,
        effort: `high`,
        thinking: true,
        account: `acc_claude_demo`,
        branch: `agent/checkout-stripe`,
        base: `4f1c8ab`,
        costUsd: 0.42,
        inputTokens: 46_200,
        outputTokens: 5_240,
        contextTokens: 34_000,
        contextWindow: 200_000,
        activity: { tool: `Edit`, target: `web/src/pricing/CheckoutPanel.tsx`, todo: `Wire the checkout session endpoint` },
        startedAt: now - minutes(4),
        updatedAt: now - 1_500,
        seenAt: now - minutes(4),
        attention: NO_ATTENTION,
        turns: 6,
        toolUses: 74,
        subagents: { running: 3, total: 5 },
        diff: { files: 3, insertions: 64, deletions: 12 },
        // Both people, one of them the reader: the chip is lit and its hover reads "Grace Hopper, you".
        reactions: [
            {
                emoji: `👍`,
                by: [
                    { ...GRACE, at: now - minutes(3) },
                    { ...ADA, at: now - minutes(2) },
                ],
            },
            { emoji: `🚀`, by: [{ ...GRACE, at: now - minutes(3) }] },
        ],
    },
    {
        id: AWAITING_AGENT_ID,
        startIn: `web`,
        sessionId: `ses_01j9flaky`,
        title: `Fix the flaky signup e2e test`,
        status: `awaiting`,
        provider: `claude`,
        harness: `claude-code`,
        model: `claude-opus-5`,
        effort: `max`,
        thinking: true,
        account: `acc_claude_demo`,
        branch: `agent/flaky-signup`,
        base: `4f1c8ab`,
        costUsd: 0.18,
        inputTokens: 21_400,
        outputTokens: 2_480,
        contextTokens: 16_800,
        contextWindow: 200_000,
        // Parked on its question for most of an hour: its cache is in the last fifth of its life, so the card offers to keep it.
        promptCache: { at: now - minutes(50), ttlMs: minutes(60), rollsAt: midnightAfter(now), keepableUntil: Math.min(midnightAfter(now), now + minutes(10 + 9 * 50)) },
        updatedAt: now - minutes(2),
        seenAt: now - minutes(9),
        attention: { ...NO_ATTENTION, question: true },
        turns: 3,
        toolUses: 28,
        diff: { files: 2, insertions: 22, deletions: 6 },
        // The flake it is chasing failed again on its last run, which is what it is asking about.
        proof: { at: now - minutes(2), verification: `failing`, check: `pnpm -C web e2e signup.spec.ts` },
    },
    {
        id: CONFLICT_AGENT_ID,
        startIn: `api`,
        sessionId: `ses_01j9auth`,
        title: `Refactor the auth middleware onto the new session store`,
        status: `conflict`,
        provider: `codex`,
        harness: `native`,
        model: `gpt-5.2-codex`,
        account: `acc_claude_demo`,
        branch: `agent/auth-middleware`,
        base: `4f1c8ab`,
        costUsd: 0.54,
        inputTokens: 40_600,
        outputTokens: 5_600,
        contextTokens: 32_000,
        contextWindow: 272_000,
        updatedAt: now - minutes(11),
        seenAt: now - minutes(40),
        attention: { ...NO_ATTENTION, conflict: true },
        turns: 9,
        toolUses: 118,
        diff: { files: 3, insertions: 72, deletions: 18 },
    },
    {
        id: LATENCY_AGENT_ID,
        startIn: `api`,
        // CI job holding a control token; renders as the card's second provenance line.
        startedBy: `token:nightly CI`,
        sessionId: `ses_01j9latency`,
        title: `Investigate the p99 latency spike on /checkout`,
        status: `running`,
        provider: `codex`,
        harness: `native`,
        model: `gpt-5.2-codex`,
        effort: `medium`,
        account: `acc_claude_demo`,
        branch: `agent/latency-p99`,
        base: `4f1c8ab`,
        costUsd: 0.16,
        inputTokens: 18_600,
        outputTokens: 1_720,
        contextTokens: 11_400,
        contextWindow: 272_000,
        activity: { tool: `Bash`, target: `pnpm -C api bench:checkout --p99`, todo: `Reproduce the spike under load` },
        startedAt: now - minutes(1),
        updatedAt: now - 900,
        seenAt: now - minutes(1),
        attention: NO_ATTENTION,
        turns: 2,
        toolUses: 19,
    },
    // Two steps of one workflow run: ordinary agents in every respect except sharing a `workflow` name.
    {
        id: `wf-a3f19c22-review-perf`,
        startIn: `web`,
        sessionId: `ses_01j9wfperf`,
        title: `Review the checkout change for performance regressions`,
        status: `running`,
        provider: `claude`,
        harness: `claude-code`,
        model: `claude-sonnet-5`,
        effort: `high`,
        account: `acc_claude_demo`,
        branch: `agent/wf-a3f19c22-review-perf`,
        base: `4f1c8ab`,
        costUsd: 0.13,
        inputTokens: 13_200,
        outputTokens: 1_180,
        contextTokens: 8_600,
        contextWindow: 200_000,
        activity: { tool: `Read`, target: `api/src/checkout/session.ts`, todo: `Trace the added round-trips` },
        startedAt: now - minutes(2),
        updatedAt: now - 1_100,
        seenAt: now - minutes(2),
        attention: NO_ATTENTION,
        turns: 2,
        toolUses: 21,
        loop: { state: `running`, iteration: 2, maxIterations: 6, goal: `no added round-trips on the hot path` },
        workflow: { runId: `a3f19c22`, name: `Ship a reviewed change`, step: `Review for performance`, index: 3, total: 4 },
    },
    {
        id: `wf-a3f19c22-review-security`,
        startIn: `web`,
        sessionId: `ses_01j9wfsec`,
        title: `Review the checkout change for security holes`,
        status: `running`,
        provider: `codex`,
        harness: `native`,
        model: `gpt-5.2-codex`,
        effort: `high`,
        account: `acc_claude_demo`,
        branch: `agent/wf-a3f19c22-review-security`,
        base: `4f1c8ab`,
        costUsd: 0.08,
        inputTokens: 9_800,
        outputTokens: 880,
        contextTokens: 6_400,
        contextWindow: 272_000,
        activity: { tool: `Grep`, target: `webhook signature verification`, todo: `Check the webhook is authenticated` },
        startedAt: now - minutes(2) + 1_400,
        updatedAt: now - 700,
        seenAt: now - minutes(2),
        attention: NO_ATTENTION,
        turns: 1,
        toolUses: 14,
        loop: { state: `running`, iteration: 1, maxIterations: 6, goal: `no unauthenticated path reaches the ledger` },
        workflow: { runId: `a3f19c22`, name: `Ship a reviewed change`, step: `Review for security`, index: 4, total: 4 },
    },
    {
        id: REVIEW_AGENT_ID,
        startIn: `api`,
        sessionId: `ses_01j9soft`,
        title: `Soft-delete the users table`,
        status: `ready`,
        provider: `claude`,
        harness: `claude-code`,
        model: `claude-sonnet-5`,
        account: `acc_claude_demo`,
        branch: `agent/soft-deletes`,
        base: `4f1c8ab`,
        autoLand: false,
        costUsd: 0.68,
        inputTokens: 52_000,
        outputTokens: 7_100,
        contextTokens: 40_000,
        contextWindow: 200_000,
        // Held for review and kept warm meanwhile: refreshed twice, so picking it up reads the cache instead of re-sending.
        promptCache: { at: now - minutes(6), ttlMs: minutes(60), rollsAt: midnightAfter(now), keepableUntil: Math.min(midnightAfter(now), now + minutes(54 + 7 * 50)) },
        keepWarm: { since: now - minutes(106), until: now + minutes(134), refreshes: 2, readTokens: 39_400 },
        updatedAt: now - minutes(18),
        seenAt: now - minutes(18),
        attention: NO_ATTENTION,
        turns: 12,
        toolUses: 164,
        diff: { files: 4, insertions: 68, deletions: 14 },
        // Somebody else's mark, waiting: work held on a branch is exactly what a teammate says 👀 about.
        reactions: [{ emoji: `👀`, by: [{ ...GRACE, at: now - minutes(16) }] }],
        jobs: SOFT_DELETES_JOBS(now).map(({ command: _command, ...job }) => job),
        proof: { at: now - minutes(18), verification: `verified`, check: `pnpm -C api test src/db` },
    },
    {
        id: RELEASE_NOTES_AGENT_ID,
        owner: { email: `ada@acme.dev`, name: `Ada Lovelace`, since: now - minutes(140) },
        startedBy: `ada@acme.dev`,
        sessionId: `ses_01j9notes`,
        title: `Draft the release notes for 2.4`,
        status: `landed`,
        provider: `claude`,
        harness: `claude-code`,
        model: `claude-haiku-4-5-20251001`,
        account: `acc_claude_demo`,
        branch: `agent/release-notes`,
        base: `4f1c8ab`,
        costUsd: 0.04,
        inputTokens: 9_200,
        outputTokens: 1_180,
        contextTokens: 7_400,
        contextWindow: 200_000,
        updatedAt: now - minutes(34),
        seenAt: now - minutes(33),
        attention: NO_ATTENTION,
        turns: 2,
        toolUses: 11,
        diff: { files: 1, insertions: 22, deletions: 3 },
        // It reworded the changelog page's headings and never ran or opened it: pushed, it is what made `web`'s main CI fail.
        proof: { at: now - minutes(34), verification: `unproven`, unviewed: 1 },
    },
    {
        id: `cnv_dep_audit`,
        owner: { email: `grace@acme.dev`, name: `Grace Hopper`, since: now - minutes(95) },
        startedBy: `ada@acme.dev`,
        sessionId: `ses_01j9audit`,
        title: `Nightly dependency audit, 3 advisories, 2 patched`,
        status: `idle`,
        provider: `claude`,
        harness: `claude-code`,
        model: `claude-sonnet-5`,
        account: `ops@acme.dev`,
        branch: `agent/dep-audit`,
        base: `9b2d10e`,
        origin: { automationId: `nightly-audit`, provider: `discord`, channelId: `1180-eng-alerts`, author: `#eng-alerts` },
        costUsd: 0.14,
        inputTokens: 20_400,
        outputTokens: 2_360,
        contextTokens: 12_600,
        contextWindow: 200_000,
        updatedAt: now - minutes(392),
        seenAt: now - minutes(120),
        attention: NO_ATTENTION,
        turns: 4,
        toolUses: 46,
        diff: { files: 3, insertions: 14, deletions: 9 },
        proof: { at: now - minutes(392), verification: `verified`, check: `pnpm -C api test` },
        // The third advisory was in an installed extension, and it patched the installed copy in place: live in every
        // conversation, on no branch, and gone with that extension's next update.
        reach: {
            at: now - minutes(392),
            live: [{ path: `${STATE_DIR}/local/extensions/intentic-deployments`, extension: `intentic.deployments` }],
        },
    },
    // Started by the sandbox, not by anyone on the team, at the first failed job of the release notes' push to `web`'s
    // main, and sent the next push's failures on main too: its second turn is working on both.
    {
        id: WEB_MAIN_FIXER_ID,
        startIn: `web`,
        sessionId: `ses_01j9cifixweb`,
        title: `Fix CI: Draft the release notes for 2.4`,
        status: `running`,
        provider: `claude`,
        harness: `claude-code`,
        model: `claude-sonnet-5`,
        effort: `high`,
        account: `acc_claude_demo`,
        branch: `agent/${WEB_MAIN_FIXER_ID}`,
        base: `9d20f6b`,
        costUsd: 0.11,
        inputTokens: 18_900,
        outputTokens: 1_640,
        contextTokens: 14_200,
        contextWindow: 200_000,
        activity: { tool: `Bash`, target: `pnpm -C web vitest run src/pages/changelog.test.ts`, todo: `Re-run only the failing tests` },
        startedAt: now - minutes(6),
        updatedAt: now - 1_300,
        seenAt: now - minutes(6),
        attention: NO_ATTENTION,
        turns: 2,
        toolUses: 23,
        diff: { files: 1, insertions: 6, deletions: 4 },
    },
    // `api`'s: it read the logs, found the failure outside the code, and finished without changing anything, so main's failure
    // was handed back and waits for you.
    {
        id: API_MAIN_FIXER_ID,
        startIn: `api`,
        sessionId: `ses_01j9cifixapi`,
        title: `Fix CI: Bump the Stripe SDK to 17`,
        status: `idle`,
        provider: `claude`,
        harness: `claude-code`,
        model: `claude-sonnet-5`,
        effort: `high`,
        account: `acc_claude_demo`,
        branch: `agent/${API_MAIN_FIXER_ID}`,
        base: `b3e9a07`,
        costUsd: 0.09,
        inputTokens: 15_300,
        outputTokens: 1_210,
        contextTokens: 11_800,
        contextWindow: 200_000,
        updatedAt: now - minutes(19),
        seenAt: now - minutes(40),
        attention: NO_ATTENTION,
        turns: 3,
        toolUses: 29,
    },
    {
        id: HELD_AGENT_ID,
        startIn: `web`,
        sessionId: `ses_01j9supportcard`,
        title: `Summary card for the support dashboard`,
        status: `error`,
        failureCode: `sandbox-memory-low`,
        failure: `Sandbox memory is low: 12.4 GiB resident + 3.6 GiB swapped, against 18.0 GiB.`,
        provider: `claude`,
        harness: `claude-code`,
        model: `claude-sonnet-5`,
        effort: `high`,
        account: `acc_claude_demo`,
        branch: `agent/support-card`,
        base: `4f1c8ab`,
        costUsd: 0.19,
        inputTokens: 16_800,
        outputTokens: 1_940,
        contextTokens: 12_600,
        contextWindow: 200_000,
        updatedAt: now - minutes(1),
        seenAt: now - minutes(1),
        attention: NO_ATTENTION,
        turns: 1,
        toolUses: 14,
        queue: {
            items: [
                {
                    id: HELD_MESSAGE_ID,
                    text: `Now put the same summary card on the support dashboard. Match this capture: counts on the left, the "Queue clear" pill top right.`,
                    attachments: [SUPPORT_SWEEP_PATH],
                    voice: `person`,
                    queuedAt: now - minutes(1),
                    revision: 3,
                },
            ],
            revision: 3,
            paused: `refused`,
        },
    },
    {
        id: SCHEDULED_AGENT_ID,
        startIn: `web`,
        title: `Document the new checkout in the user guide`,
        status: `idle`,
        provider: `claude`,
        harness: `claude-code`,
        model: `claude-sonnet-5`,
        effort: `medium`,
        account: `acc_claude_demo`,
        branch: `agent/checkout-docs`,
        updatedAt: now - minutes(3),
        seenAt: now - minutes(3),
        attention: NO_ATTENTION,
        autoLand: true,
        queue: {
            items: [
                {
                    id: SCHEDULED_MESSAGE_ID,
                    text: `Once the Stripe checkout is in, document it in the user guide: the new plan picker, the checkout steps, and what a declined card shows.`,
                    voice: `person`,
                    queuedAt: now - minutes(3),
                    revision: 1,
                    after: FEATURED_AGENT_ID,
                },
            ],
            revision: 1,
            paused: `scheduled`,
            after: FEATURED_AGENT_ID,
        },
    },
    ...spawnedChildren(now),
    ...auditFamily(now),
];

// What a quiet recording (mode.ts `demoQuiet`) takes off a card: the marks of a busy moment rather than of the work.
// A teammate's reactions, a prompt cache counting down, a command still running past its turn, a helper tray, a queued
// message, a check that failed or never ran, work its last turn left outside its branch, and the token a CI job started
// it with. The title, model, branch, diff, cost, activity and lane stay, and so does a check that passed, which is the
// one mark a finished card should carry.
export const quietCard = ({
    reactions: _reactions,
    promptCache: _promptCache,
    keepWarm: _keepWarm,
    jobs: _jobs,
    subagents: _subagents,
    queue: _queue,
    proof,
    reach: _reach,
    startedBy,
    ...card
}: AgentSummary): AgentSummary => ({
    ...card,
    ...(proof?.verification === `verified` ? { proof } : {}),
    ...(startedBy === undefined || startedBy.startsWith(`token:`) ? {} : { startedBy }),
});
