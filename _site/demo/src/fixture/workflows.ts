import type { Workflow, WorkflowRun, WorkflowSummary } from "@intentic/sandbox-contract";

/* THE WORKFLOW the demo has designed, and the run of it that is going on right now.
 *
 * It is the SAME run the fleet fixture's two review cards are steps of, `wf-a3f19c22-review-perf` and
 * `wf-a3f19c22-review-security` are named in both files, so clicking a card's workflow mark lands on the graph
 * those exact cards are nodes of. Two surfaces agreeing about one run is the whole point of the mark; a demo
 * where the link goes somewhere plausible-but-unrelated would be teaching the wrong thing.
 *
 * The shape is the one the feature exists for: a chain that carries ONE session through plan → build, then a
 * fan-out to two reviewers that are `fresh`, different sessions, because the session that made the change is
 * the worst available judge of it. Steps 1 and 2 share a conversation (`continue`); 3 and 4 each get their own.
 */

const minutes = (count: number): number => count * 60_000;

// The chain's own conversation, steps 1 and 2 ran on it, which is what `continue` means.
const CHAIN_CONVERSATION = `wf-a3f19c22-plan`;

const demoWorkflow = (): Workflow => ({
    id: `ship-a-reviewed-change`,
    name: `Ship a reviewed change`,
    description: `Plan it and build it on one branch, then have two reviewers who did none of the work read it independently.`,
    maxParallel: 2,
    steps: [
        {
            id: `plan`,
            title: `Plan the change`,
            goal: `a plan naming every file that has to change and why`,
            prompt: `Read the checkout flow and write the plan. Do not edit anything yet.`,
            needs: [],
            handoff: `fresh`,
            output: {
                kind: `json`,
                fields: [
                    { name: `files`, type: `string[]`, description: `every file that has to change, as a repo-relative path`, required: true },
                    { name: `risks`, type: `string`, description: `the one thing most likely to break, in a sentence`, required: true },
                ],
            },
            checks: [],
            context: `continue`,
        },
        {
            id: `build`,
            title: `Make the change`,
            goal: `the plan is implemented and the suite is green`,
            prompt: `Implement the plan you just wrote, then run the suite and fix what it says.`,
            needs: [`plan`],
            handoff: `continue`,
            output: { kind: `claim` },
            checks: [{ kind: `command`, command: `pnpm test` }],
            context: `continue`,
        },
        {
            id: `review-perf`,
            title: `Review for performance`,
            goal: `no added round-trips on the hot path`,
            prompt: `Read the diff on the branch you were given. Report any request the change adds to the checkout path.`,
            needs: [`build`],
            handoff: `fresh`,
            output: {
                kind: `json`,
                fields: [
                    {
                        name: `findings`,
                        type: `string[]`,
                        description: `each added round-trip, with the file and line that makes it`,
                        required: true,
                    },
                ],
            },
            checks: [],
            context: `fresh`,
        },
        {
            id: `review-security`,
            title: `Review for security`,
            goal: `no unauthenticated path reaches the ledger`,
            prompt: `Read the diff on the branch you were given. Report any path that reaches the ledger without an authenticated caller.`,
            needs: [`build`],
            handoff: `fresh`,
            output: {
                kind: `json`,
                fields: [
                    {
                        name: `findings`,
                        type: `string[]`,
                        description: `each unauthenticated path to the ledger, with the file and line`,
                        required: true,
                    },
                ],
            },
            checks: [],
            context: `fresh`,
        },
    ],
});

/* The run in flight: the chain is done, both reviewers are going. That is the state worth showing, a graph
 * with settled nodes behind it and live ones in front reads as a picture of progress, which a run that has
 * only just started does not.
 */
export const demoRuns = (now: number): WorkflowRun[] => [
    {
        runId: `a3f19c22`,
        workflow: demoWorkflow(),
        repos: [{ repo: `root`, base: `1111111111111111111111111111111111111111` }],
        state: `running`,
        startedAt: now - minutes(21),
        resumed: 0,
        steps: [
            {
                stepId: `plan`,
                state: `done`,
                conversationId: CHAIN_CONVERSATION,
                startedAt: now - minutes(21),
                endedAt: now - minutes(16),
                iterations: 2,
                costUsd: 0.41,
                loopState: `done`,
                document: {
                    done: true,
                    reason: `Six files, and the webhook handler is the risky one.`,
                    data: { files: `api/src/checkout/*.ts, web/src/pricing/CheckoutPanel.tsx`, risks: `webhook replay` },
                },
                report: `The change is confined to the checkout session builder and its webhook handler.`,
            },
            {
                stepId: `build`,
                state: `done`,
                conversationId: CHAIN_CONVERSATION,
                startedAt: now - minutes(16),
                endedAt: now - minutes(3),
                iterations: 5,
                costUsd: 1.96,
                loopState: `done`,
                document: { done: true, reason: `Suite is green after the third fix.`, evidence: `pnpm test, 1,412 passed` },
                report: `Implemented the plan; the suite went green once the webhook idempotency key was added.`,
            },
            {
                stepId: `review-perf`,
                state: `running`,
                conversationId: `wf-a3f19c22-review-perf`,
                startedAt: now - minutes(2),
                iterations: 2,
                costUsd: 0.28,
            },
            {
                stepId: `review-security`,
                state: `running`,
                conversationId: `wf-a3f19c22-review-security`,
                startedAt: now - minutes(2),
                iterations: 1,
                costUsd: 0.19,
            },
        ],
    },
];

// The design, carrying whatever runs of it the board is showing, which is the daemon's call, not this file's:
// a demo mode that leaves the two review agents off the board leaves their run off it too (daemon.ts).
export const demoWorkflows = (runs: WorkflowRun[]): WorkflowSummary[] => [{ ...demoWorkflow(), runs }];
