import type { Automation, AutomationApproval, AutomationSummary } from "@intentic/sandbox-contract";

/* THE AUTOMATIONS acme-shop runs while nobody is watching — the surface that turns a sandbox from a place you
 * open into a colleague that works overnight. One of each kind the trigger union can be, because the page's
 * whole claim is that they are the same machine:
 *
 *   schedule  — the nightly dependency audit (a code CHORE: maintenance of this codebase), and its runs are
 *               the fleet card the board shows as an automation's overnight pass.
 *   listener  — Discord: @mention the agent in #eng-alerts and it answers there, as a participant.
 *   listener  — the Doorbell webchat on the marketing site, held for approval because it is driven by strangers.
 *   workspace — a land into the main tree wakes the doc-check chore.
 *   event     — CI: a red pipeline wakes an agent with the failed job's log already in hand.
 *
 * `runs` are what make a row honest: an automation with no history is a promise, and one with a `skipped` and an
 * `error` in its last five is what running unattended actually looks like. The approvals queue holds one wake,
 * so the page's "held for you" half is not an empty affordance either. */

const minutes = (count: number): number => count * 60_000;
const hours = (count: number): number => count * 3_600_000;

const seed = (now: number): AutomationSummary[] => [
    {
        id: `aut_nightly_audit`,
        trigger: { kind: `schedule`, cron: `0 3 * * *` },
        guard: `pnpm audit --json | jq -e '.metadata.vulnerabilities.high > 0'`,
        prompt: `Audit the workspace's dependencies. Patch what can be patched without a major bump, run the tests, and open one conversation summarising what you left alone and why.`,
        chore: true,
        agent: `claude`,
        model: `claude-sonnet-5`,
        enabled: true,
        nextRun: now + hours(9),
        runs: [
            { at: now - hours(7), outcome: `completed`, detail: `3 advisories, 2 patched`, conversationId: `cnv_dep_audit` },
            { at: now - hours(31), outcome: `skipped`, detail: `guard exited 1 — no high advisories` },
            { at: now - hours(55), outcome: `completed`, detail: `1 advisory, patched`, conversationId: `cnv_dep_audit_prev` },
            { at: now - hours(79), outcome: `skipped`, detail: `guard exited 1 — no high advisories` },
        ],
    },
    {
        id: `aut_discord_oncall`,
        trigger: { kind: `listener`, provider: `discord`, channelId: `1180-eng-alerts`, eventType: `message`, mentioned: true },
        prompt: `You were mentioned in #eng-alerts. Read the thread, check the sandbox for what it refers to, and reply in the channel. If it is a code question, answer with the file and line.`,
        allowedTools: [`Read`, `Grep`, `Bash(git log:*)`],
        enabled: true,
        runs: [
            { at: now - minutes(52), outcome: `completed`, detail: `replied in #eng-alerts`, conversationId: `cnv_discord_reply` },
            { at: now - hours(20), outcome: `completed`, detail: `replied in #eng-alerts`, conversationId: `cnv_discord_reply_prev` },
        ],
    },
    {
        id: `aut_doorbell`,
        trigger: { kind: `listener`, provider: `webchat`, allowedOrigins: [`https://acme.example`] },
        prompt: `A visitor is asking on the marketing site. Answer from the docs in this workspace only; if the answer isn't there, say so and offer to pass it on.`,
        webchat: {
            title: `Ask acme`,
            greeting: `Ask anything about the product — a real agent answers.`,
            accent: `#f0662a`,
            position: `bottom-right`,
            access: `public`,
            antiBot: `pow`,
        },
        requireApproval: true,
        enabled: true,
        runs: [{ at: now - hours(4), outcome: `completed`, detail: `answered 2 messages`, conversationId: `cnv_doorbell_visitor` }],
    },
    {
        id: `aut_docs_after_land`,
        trigger: { kind: `workspace`, event: `agent.landed`, repo: `api` },
        prompt: `Something landed in api. Check whether the docs still describe it — the route table, the schema notes and the README — and fix what drifted.`,
        chore: true,
        enabled: true,
        runs: [
            { at: now - hours(2), outcome: `completed`, detail: `README route table updated`, conversationId: `cnv_docs_drift` },
            { at: now - hours(9), outcome: `interrupted`, detail: `the daemon restarted mid-wake` },
        ],
    },
    {
        id: `aut_ci_red`,
        trigger: { kind: `event`, token: `ci` },
        prompt: `A pipeline went red. Read the failed job's log, reproduce the failure in the sandbox, and either fix it or explain in one paragraph why it is not a code problem.`,
        agent: `codex`,
        harness: `native`,
        enabled: false,
        runs: [{ at: now - hours(26), outcome: `error`, detail: `the turn ended without reaching a verdict` }],
    },
];

const seedApprovals = (now: number): AutomationApproval[] => [
    {
        id: `apr_doorbell_1`,
        automationId: `aut_doorbell`,
        payload: `visitor: "Does intentic work with a self-hosted GitLab?"`,
        origin: { automationId: `aut_doorbell`, provider: `webchat`, author: `visitor · 84.12.9.x` },
        title: `Doorbell: self-hosted GitLab?`,
        createdAt: now - minutes(6),
    },
];

let automations: AutomationSummary[] | undefined;
let approvals: AutomationApproval[] | undefined;

const state = (now: number): AutomationSummary[] => (automations ??= seed(now));
const heldState = (now: number): AutomationApproval[] => (approvals ??= seedApprovals(now));

export const automationsList = (now: number): AutomationSummary[] => state(now);
export const automationApprovals = (now: number): AutomationApproval[] => heldState(now);

/* A save is real, which is what makes the page's switch and its New automation dialog worth clicking: the row
 * flips (or appears) and stays that way. Everything a save cannot fake — the cron that fires it, the Discord
 * bot that hears it — is the sandbox's half, and the demo says so in the refusals below. */
export const saveAutomation = (now: number, automation: Automation): void => {
    const all = state(now);
    const index = all.findIndex((candidate) => candidate.id === automation.id);
    const existing = all[index];
    if (existing === undefined) {
        all.unshift({ ...automation, runs: [] });
        return;
    }
    // The history and the next fire belong to the row, not to the form that just edited it.
    all[index] = { ...existing, ...automation };
};

export const deleteAutomation = (now: number, id: string): void => {
    automations = state(now).filter((automation) => automation.id !== id);
};

/** Approving or rejecting a held wake empties the queue row — the one thing the approvals list is for. */
export const resolveApproval = (now: number, id: string): void => {
    approvals = heldState(now).filter((approval) => approval.id !== id);
};
