import type { AgentHarness, AgentProvider, SandboxHandlerOutput, TranscriptRow } from "@intentic/sandbox-contract";
import { SUPPORT_SWEEP_PATH } from "./browserShots";
import { DESK_REVIEW_ID, SEPTEMBER_AFTER, SEPTEMBER_BEFORE, SEPTEMBER_PAGE, SEPTEMBER_PAGE_PATH, SEPTEMBER_PRINT_PATH } from "./desk";
import {
    API_MAIN_FIXER_ID,
    HELD_AGENT_ID,
    REVIEW_AGENT_ID,
    SOFT_DELETES_JOBS,
    SOFT_E2E_JOB,
    SOFT_TYPECHECK_JOB,
    WEB_MAIN_FIXER_ID,
} from "./fleet";
import { MAYA_CHAT_ID, OWEN_CHAT_ID, PRIYA_CHAT_ID } from "./openChats";

// Transcript route body: messages plus the session id, provider, harness and account they're bound to. A reopened tab
// needs all three to decide whether its next message resumes this session.
interface AgentTranscript {
    readonly sessionId?: string;
    readonly provider?: AgentProvider;
    readonly harness?: AgentHarness;
    readonly account?: string;
    readonly messages: TranscriptRow[];
}

// /agents/{id}/transcript returns the restored transcript for a finished agent; other cards return empty, honestly.
// Diffs match the review panel's. Fixtured: the finished-delta agent, main's two CI fix agents, the desk's review and
// one per persona; persona chats touch no files, only their accounts.

const SCHEMA_BEFORE = `export const users = pgTable("users", {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
});
`;

const SCHEMA_AFTER = `export const users = pgTable("users", {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Soft delete: rows are retired, never removed, every read filters on this.
    deletedAt: timestamp("deleted_at"),
});

export const liveUsers = () => db.select().from(users).where(isNull(users.deletedAt));
`;

const USERS_ROUTE_BEFORE = `export const deleteUser = async (id: string) => {
    await db.delete(users).where(eq(users.id, id));
    return { ok: true };
};
`;

const USERS_ROUTE_AFTER = `export const deleteUser = async (id: string) => {
    // Retire, never remove: the row stays, every read filters it out (see liveUsers).
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, id));
    return { ok: true };
};
`;

// The row a background job's start leaves, from the same job the roster reports live (fleet.ts).
const jobRow = (id: string): TranscriptRow => {
    const job = SOFT_DELETES_JOBS(Date.now()).find((entry) => entry.id === id)!;
    return { role: `notice`, text: `Background job: ${job.label}`, backgroundJob: { id, label: job.label, command: job.command, startedAt: job.startedAt } };
};

const SOFT_DELETES: AgentTranscript = {
    sessionId: `ses_01j9soft`,
    provider: `claude`,
    harness: `claude-code`,
    account: `acc_claude_demo`,
    messages: [
        {
            role: `user`,
            text: `Migrate the users table to soft deletes. Nothing should hard-delete a user row again, reads filter the retired ones out.`,
        },
        {
            role: `assistant`,
            text: `Three places touch users directly: the schema, the delete route, and the web client's typed row. I'll start with the schema and let the rest follow from it.`,
            thinking: `A soft delete is only safe if every read path filters it. Better to add one exported helper the routes share than to sprinkle isNull() at each call site, the next route that forgets is the bug.`,
            tools: [
                {
                    id: `tc_soft_read`,
                    name: `Read`,
                    category: `read`,
                    status: `completed`,
                    target: `api/src/db/schema.ts`,
                    locations: [{ path: `api/src/db/schema.ts`, line: 1 }],
                    content: [{ type: `text`, text: `31 lines · users, sessions and orders; no deleted_at anywhere yet.` }],
                },
                {
                    id: `tc_soft_grep`,
                    name: `Grep`,
                    category: `search`,
                    status: `completed`,
                    target: `db.delete(users)`,
                    content: [{ type: `text`, text: `2 matches\napi/src/routes/users.ts:14\napi/src/jobs/purge.ts:38` }],
                },
            ],
        },
        {
            role: `assistant`,
            text: `Schema first, the column plus a \`liveUsers()\` helper, so filtering is one import rather than a rule everyone has to remember.`,
            tools: [
                {
                    id: `tc_soft_schema`,
                    name: `Edit`,
                    category: `edit`,
                    status: `completed`,
                    target: `api/src/db/schema.ts`,
                    locations: [{ path: `api/src/db/schema.ts`, line: 5 }],
                    content: [{ type: `diff`, path: `api/src/db/schema.ts`, oldText: SCHEMA_BEFORE, newText: SCHEMA_AFTER }],
                },
                {
                    id: `tc_soft_migration`,
                    name: `Write`,
                    category: `edit`,
                    status: `completed`,
                    target: `api/src/db/migrations.ts`,
                    locations: [{ path: `api/src/db/migrations.ts` }],
                    content: [{ type: `text`, text: `+62 lines · adds deleted_at (nullable) and a partial index on the live rows.` }],
                },
                {
                    id: `tc_soft_route`,
                    name: `Edit`,
                    category: `edit`,
                    status: `completed`,
                    target: `api/src/routes/users.ts`,
                    locations: [{ path: `api/src/routes/users.ts`, line: 14 }],
                    content: [{ type: `diff`, path: `api/src/routes/users.ts`, oldText: USERS_ROUTE_BEFORE, newText: USERS_ROUTE_AFTER }],
                },
            ],
        },
        jobRow(SOFT_TYPECHECK_JOB),
        {
            role: `assistant`,
            text: `The purge job is the one place a hard delete still belongs, it runs on rows retired more than 30 days ago, so I left it alone and covered it with a test instead.`,
            tools: [
                {
                    id: `tc_soft_tests`,
                    name: `Bash`,
                    category: `execute`,
                    status: `completed`,
                    target: `pnpm -C api test users`,
                    content: [
                        {
                            type: `text`,
                            text: `✓ api/tests/users.spec.ts (7)\n  ✓ deleteUser retires the row\n  ✓ liveUsers hides retired rows\n  ✓ purge removes rows retired over 30 days\n\nTest Files  1 passed (1)\n     Tests  7 passed (7)\n  Duration  3.41s`,
                        },
                    ],
                },
            ],
        },
        jobRow(SOFT_E2E_JOB),
        {
            role: `assistant`,
            text: `Done, **4 files, +210 / −55**, held on \`agent/soft-deletes\`.\n\nOne thing to decide when you read it: the API still returns retired users to admin tokens (that's what the \`includeRetired\` flag does). If you'd rather they were invisible everywhere, say so and I'll drop the flag.`,
        },
    ],
};

// Persona chat; browser capture is one compact artifact, enough evidence without becoming a dashboard.
const MAYA_SUPPORT: AgentTranscript = {
    sessionId: `ses_01j9maya`,
    provider: `claude`,
    harness: `claude-code`,
    account: `acc_claude_demo`,
    messages: [
        {
            role: `user`,
            text: `Morning, Maya. Clear the overnight support queue. Use your judgment on refunds under $150, and only bring me something that genuinely needs a decision.`,
        },
        {
            role: `assistant`,
            text: `On it. I found 18 new conversations: 14 routine, three that need a personal reply, and one renewal at risk. I'm handling the routine queue first, then I'll check the renewal in its account context.`,
        },
        {
            role: `assistant`,
            text: `Seventeen are handled, 11 replies sent, four duplicates merged, and two refunds issued for **$68 total**.\n\nThe one judgment call is Northwind's renewal. Their SSO rollout is blocked on SCIM mapping. I drafted a reply, but held it because it offers hands-on setup time.`,
        },
        {
            role: `user`,
            text: `Send it. Offer a 20-minute setup session tomorrow, book it yourself, and make sure we follow up after they try the fix.`,
        },
        {
            role: `assistant`,
            tools: [
                {
                    id: `tc_maya_support_sweep`,
                    name: `Browser take screenshot`,
                    category: `other`,
                    status: `completed`,
                    target: `Inbox cleared · follow-up booked`,
                    content: [{ type: `image`, path: SUPPORT_SWEEP_PATH }],
                },
            ],
            text: `Done. Jordan booked **10:30 tomorrow**. I attached their SSO logs to the account and scheduled a Friday check-in. The queue is clear; there's nothing else you need to decide.`,
        },
    ],
};

// Shorter than Maya's on purpose: writing, posted through the persona's own accounts.
const OWEN_LAUNCH: AgentTranscript = {
    sessionId: `ses_01j9owen`,
    provider: `claude`,
    harness: `claude-code`,
    account: `acc_claude_demo`,
    messages: [
        {
            role: `user`,
            text: `2.4 ships Thursday. Draft the launch thread, lead with soft deletes, keep it to five posts, and don't announce a date for the audit log.`,
        },
        {
            role: `assistant`,
            text: `Drafted five posts. The first opens on the restore, not the schema, "delete a customer, change your mind, get them back" tested better in the 2.2 thread than any feature framing did.\n\nNo date on the audit log; it's one line saying it's next.`,
        },
        {
            role: `user`,
            text: `Good. Queue it for 09:00 Thursday and cross-post the first one to LinkedIn.`,
        },
        {
            role: `assistant`,
            text: `Queued for **Thursday 09:00**, and the opener is scheduled on LinkedIn for the same minute. I'll hold the replies for you rather than answering as the brand.`,
        },
    ],
};

// Ends on a question, not a result: not every persona chat should read as finished.
const PRIYA_PAYOUTS: AgentTranscript = {
    sessionId: `ses_01j9priya`,
    provider: `claude`,
    harness: `claude-code`,
    account: `acc_claude_demo`,
    messages: [
        {
            role: `user`,
            text: `Reconcile August payouts against the ledger and tell me what doesn't match.`,
        },
        {
            role: `assistant`,
            text: `412 payouts, **$186,340** settled. All but three reconcile to the cent.\n\nThe three are the same shape: a refund issued after the payout closed, so August paid out on revenue September took back. Two are under $40. The third is **$2,180**, Northwind's annual, refunded on the 29th.`,
        },
        {
            role: `assistant`,
            text: `I can net the three against September's payout, or open a credit note for each. Netting is one line and hides the reversal; credit notes leave a trail your accountant can follow.\n\nWhich way do you want them?`,
        },
    ],
};

// The desk recording's finished draft: a document moved into a template, the same edit the review page draws as
// tracked changes. Reads the template first, so the plan is the template's and not the assistant's.
const SEPTEMBER_TEMPLATE: AgentTranscript = {
    sessionId: `ses_desk_september`,
    provider: `claude`,
    harness: `claude-code`,
    account: `acc_claude_demo`,
    messages: [
        {
            role: `user`,
            text: `Move the September newsletter into the new template: a short opening, three items with headings, the usual sign-off. Keep everything that was in it.`,
        },
        {
            role: `assistant`,
            text: `The template wants two lines up top and three headed items. September has three things in it already, the ceramics, the market and the pottery evenings, so nothing has to be cut, only shaped.`,
            thinking: `The one line worth keeping whole is the golden afternoon light: it is the only sentence in there that sounds like her. Everything else can be tightened.`,
            tools: [
                {
                    id: `tc_desk_template`,
                    name: `Read`,
                    category: `read`,
                    status: `completed`,
                    target: `newsletter/template.md`,
                    locations: [{ path: `newsletter/template.md`, line: 1 }],
                    content: [{ type: `text`, text: `19 lines · a greeting, one or two lines of opening, three headed items, the sign-off.` }],
                },
                {
                    id: `tc_desk_september`,
                    name: `Read`,
                    category: `read`,
                    status: `completed`,
                    target: `newsletter/september.md`,
                    locations: [{ path: `newsletter/september.md`, line: 1 }],
                    content: [{ type: `text`, text: `17 lines · five paragraphs, no headings; the ceramics, the Harbour Market, the pottery evenings.` }],
                },
            ],
        },
        {
            role: `assistant`,
            text: `Done. The opening is the one line about the light, the three items have the template's headings, and the sign-off is the studio's usual one. Nothing that was in it is gone.`,
            tools: [
                {
                    id: `tc_desk_edit`,
                    name: `Edit`,
                    category: `edit`,
                    status: `completed`,
                    target: `newsletter/september.md`,
                    locations: [{ path: `newsletter/september.md`, line: 1 }],
                    content: [{ type: `diff`, path: `newsletter/september.md`, oldText: SEPTEMBER_BEFORE, newText: SEPTEMBER_AFTER }],
                },
            ],
        },
        {
            role: `user`,
            text: `Can you make a Word copy I can print for the counter, and put it on the website as its own page?`,
        },
        {
            role: `assistant`,
            text: `Two copies of the same issue: a Word file for printing, and a page in the shop's own style.`,
            tools: [
                // The command's card names the file it wrote, as the sandbox records it for any command.
                {
                    id: `tc_desk_print`,
                    name: `Bash`,
                    category: `execute`,
                    status: `completed`,
                    target: `pandoc newsletter/september.md -o newsletter/september.docx`,
                    locations: [{ path: SEPTEMBER_PRINT_PATH }],
                    content: [{ type: `text`, text: `` }],
                },
                {
                    id: `tc_desk_page`,
                    name: `Write`,
                    category: `edit`,
                    status: `completed`,
                    target: SEPTEMBER_PAGE_PATH,
                    locations: [{ path: SEPTEMBER_PAGE_PATH }],
                    content: [{ type: `diff`, path: SEPTEMBER_PAGE_PATH, newText: SEPTEMBER_PAGE }],
                },
            ],
        },
        {
            role: `assistant`,
            text: `Both are ready. The Word copy fits on one page, and the web page uses the shop's colours and links back to the About page.`,
        },
    ],
};

// The one fix agent the sandbox put on `web`'s failing main line (fixture/ci.ts), in the words the daemon composes for a CI
// failure (ci/ci-fix.ts), then the next failed run on main sent to the same conversation. Both rows carry the errand they
// are, so the chat shows them as the sandbox's brief rather than as something a person typed.
const WEB_MAIN_FIX: AgentTranscript = {
    sessionId: `ses_01j9cifixweb`,
    provider: `claude`,
    harness: `claude-code`,
    account: `acc_claude_demo`,
    messages: [
        {
            role: `user`,
            errand: `ci-fix`,
            text: [
                `The CI pipeline for the workspace repo "web" failed on branch main (https://github.com/acme/shop-web/actions/runs/4818). Investigate and fix it.`,
                `Failed jobs: unit.`,
                `The logs below are the evidence — read them first; they are usually enough to name the cause.`,
                `You are in an isolated worktree: commit your fix and it goes through review.`,
                [
                    `--- failed job logs (tails) ---`,
                    ` FAIL  src/pages/changelog.test.ts > lists every release under its own heading`,
                    `TypeError: Cannot read properties of undefined (reading 'version')`,
                    ` ❯ src/pages/changelog.ts:41:19`,
                ].join(`\n`),
            ].join(`\n\n`),
        },
        {
            role: `assistant`,
            text: `The release notes renamed \`version\` to \`tag\` in each entry of the changelog, but \`Release\` still types it as \`version\`, so the page drops every heading and every link. Re-running the two changelog tests on their own before touching the type.`,
        },
        {
            role: `user`,
            errand: `ci-fix-nudge`,
            text: `Main failed again on web (https://github.com/acme/shop-web/actions/runs/4822): typecheck, unit. It is the same failure, and this conversation has it until a run of main passes.`,
        },
    ],
};

// `api`'s fix agent: it read the logs, found the failure outside the code, and said so rather than change anything.
const API_MAIN_FIX: AgentTranscript = {
    sessionId: `ses_01j9cifixapi`,
    provider: `claude`,
    harness: `claude-code`,
    account: `acc_claude_demo`,
    messages: [
        {
            role: `user`,
            errand: `ci-fix`,
            text: [
                `The CI pipeline for the workspace repo "api" failed on branch main (https://gitlab.com/acme/shop-api/-/pipelines/90314). Investigate and fix it.`,
                `Failed jobs: test:integration.`,
                `The logs below are the evidence — read them first; they are usually enough to name the cause.`,
                `You are in an isolated worktree: commit your fix and it goes through review.`,
                [
                    `--- failed job logs (tails) ---`,
                    `Error: connect ECONNREFUSED 10.0.14.7:5432`,
                    `    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16)`,
                    `FATAL: sorry, too many clients already`,
                ].join(`\n`),
            ].join(`\n\n`),
        },
        {
            role: `assistant`,
            text: `Nothing to change in the code: every test:integration failure is the CI database refusing connections ("too many clients already"), and the Stripe SDK bump touches none of the database code. The runner's Postgres service needs a higher max_connections, or the suite a smaller pool; both are settings on your CI, not in this repository.`,
        },
    ],
};

// A finished turn, then a message the sandbox turned away at the door for low memory. A turn that ran nothing is never
// recorded, so the record ends on the last turn that ran: the words wait in the queue and the card says why (fleet.ts).
const SUPPORT_CARD: AgentTranscript = {
    sessionId: `ses_01j9supportcard`,
    provider: `claude`,
    harness: `claude-code`,
    account: `acc_claude_demo`,
    messages: [
        {
            role: `user`,
            text: `Give the overnight sweep a summary card: how many conversations came in, how many were routine, and what still needs a person.`,
        },
        {
            role: `assistant`,
            text: `Added \`SweepSummaryCard\` under \`web/src/support/\`: three counts from the sweep's own record, and a pill that turns green once nothing needs a person. It reads the same record the sweep writes, so it can't drift from it.`,
        },
        { role: `notice`, text: `Finished: the work is on this agent's branch, ready to land from its review.` },
    ],
};

// A helper the checkout agent spawned on Codex, mid-way: what its chat shows under the subagent bar.
const WEBHOOK_TESTS: AgentTranscript = {
    sessionId: `ses_sub-brisk-otter-4k2m`,
    provider: `codex`,
    harness: `native`,
    messages: [
        {
            role: `user`,
            text: `Write tests for the Stripe webhook handler in api/src/webhooks: a valid signature is accepted, a tampered one is refused with 400, and a replayed event is acknowledged without being processed twice.`,
        },
        {
            role: `assistant`,
            text: `The handler verifies with \`constructEvent\` and records processed event ids in \`processed_events\`. I'll sign fixtures with the test secret rather than mocking the verifier, so the tests exercise the real check.`,
            tools: [
                { id: `call_w1`, name: `Read`, category: `read`, status: `completed`, target: `api/src/webhooks/stripe.ts` },
                { id: `call_w2`, name: `Edit`, category: `edit`, status: `completed`, target: `api/src/webhooks/stripe.test.ts` },
                { id: `call_w3`, name: `Bash`, category: `execute`, status: `in_progress`, target: `pnpm -C api test src/webhooks` },
            ],
        },
    ],
};

// The helper parked on a permission (fleet.ts `sub-keen-moth-5r8t`): a host guard card it already got past with a
// conversation-wide yes, frozen as such, and the one waiting now, whose Allow carries the wider yeses behind its caret.
const EARLIER_SEND = `curl -s -u "{{secret:stripe/secret-key}}:" https://api.stripe.com/v1/api_keys | jq -r '.data[].id'`;
const WAITING_SEND = `K="{{secret:stripe/secret-key}}"; for id in $(cat old-keys.txt); do curl -s -u "$K:" -X POST https://api.stripe.com/v1/api_keys/$id/expire; done`;
const KEY_ROTATION: AgentTranscript = {
    sessionId: `ses_sub-keen-moth-5r8t`,
    messages: [
        { role: `user`, text: `Rotate the Stripe test keys: list the live ones, expire the old pair, and put the new pair in .env.test.` },
        {
            role: `assistant`,
            text: `Listing the keys first.`,
            permission: {
                requestId: `perm_keys_list`,
                toolName: `Bash`,
                title: `Send stripe/secret-key where its host guard can't check?`,
                displayName: `Send secret`,
                program: { text: EARLIER_SEND, language: `bash`, truncated: false, spans: [{ start: 12, end: 40 }] },
                status: `everything`,
            },
        },
        {
            role: `assistant`,
            text: `Three keys are older than the new pair. Expiring them in one loop.`,
            permission: {
                requestId: `perm_keys_expire`,
                toolName: `Bash`,
                title: `Send stripe/secret-key where its host guard can't check?`,
                displayName: `Send secret`,
                explain: `stripe/secret-key's host guard lets it go unasked only to api.stripe.com, and where this command sends it cannot be read from it: it runs \`for\`, and where that sends things is not in the command's text.`,
                program: { text: WAITING_SEND, language: `bash`, truncated: false, spans: [{ start: 3, end: 31 }] },
                alwaysLabel: `Allow stripe/secret-key anywhere in this conversation`,
                status: `pending`,
            },
        },
    ],
};

const TRANSCRIPTS: Record<string, AgentTranscript> = {
    [`sub-brisk-otter-4k2m`]: WEBHOOK_TESTS,
    [`sub-keen-moth-5r8t`]: KEY_ROTATION,
    [REVIEW_AGENT_ID]: SOFT_DELETES,
    [WEB_MAIN_FIXER_ID]: WEB_MAIN_FIX,
    [API_MAIN_FIXER_ID]: API_MAIN_FIX,
    [HELD_AGENT_ID]: SUPPORT_CARD,
    [DESK_REVIEW_ID]: SEPTEMBER_TEMPLATE,
    [MAYA_CHAT_ID]: MAYA_SUPPORT,
    [OWEN_CHAT_ID]: OWEN_LAUNCH,
    [PRIYA_CHAT_ID]: PRIYA_PAYOUTS,
};

// Each recording is one whole page: it starts at the record's first message, and nothing older precedes it.
export const transcriptFor = (id: string): SandboxHandlerOutput<`agents`, `transcript`> => ({ ...(TRANSCRIPTS[id] ?? { messages: [] }), from: 0, more: false });
