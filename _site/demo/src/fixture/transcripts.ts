import type { AgentHarness, AgentProvider, TranscriptRow } from "@intentic/sandbox-contract";
import { SUPPORT_SWEEP_PATH } from "./browserShots";
import { REVIEW_AGENT_ID } from "./fleet";
import { MAYA_CHAT_ID, OWEN_CHAT_ID, PRIYA_CHAT_ID } from "./openChats";

// Transcript route body: messages plus the session id, provider, harness and account they're bound to. A reopened tab
// needs all three to decide whether its next message resumes this session.
interface AgentTranscript {
    readonly sessionId?: string;
    readonly provider?: AgentProvider;
    readonly harness?: AgentHarness;
    readonly account?: string;
    readonly messages: readonly TranscriptRow[];
}

// /agents/{id}/transcript returns the restored transcript for a finished agent; other cards return empty, honestly.
// Diffs match the review panel's. Four are fixtured: one finished-delta agent, one per persona; persona chats touch no
// files, only their accounts.

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

const TRANSCRIPTS: Record<string, AgentTranscript> = {
    [REVIEW_AGENT_ID]: SOFT_DELETES,
    [MAYA_CHAT_ID]: MAYA_SUPPORT,
    [OWEN_CHAT_ID]: OWEN_LAUNCH,
    [PRIYA_CHAT_ID]: PRIYA_PAYOUTS,
};

export const transcriptFor = (id: string): AgentTranscript => TRANSCRIPTS[id] ?? { messages: [] };
