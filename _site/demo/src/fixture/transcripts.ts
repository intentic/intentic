import type { RestoredMessage } from "@intentic/sandbox-contract";
import { SUPPORT_SWEEP_PATH } from "./browserShots";
import { REVIEW_AGENT_ID } from "./fleet";
import { MAYA_CHAT_ID, OWEN_CHAT_ID, PRIYA_CHAT_ID } from "./openChats";

/** The transcript route's body: `AgentTranscriptSchema`, the restored messages, plus the session they came from. */
interface AgentTranscript {
    readonly sessionId?: string;
    readonly messages: readonly RestoredMessage[];
}

/* WHAT A FINISHED AGENT'S CHAT HOLDS. `/agents/{id}/transcript` is what the panel reads when a conversation is
 * opened rather than attached to, every agent on the board except the one mid-turn. Answering it with an empty
 * list made the board's central move ("open the agent") land on "Start a conversation with Claude Code", as if
 * the work on the card had happened somewhere else.
 *
 * The shape is the restored one (`RestoredMessage`), not the streaming one: prose, the thinking that preceded
 * it, and the tool cards that prose introduced, which is why a reopened chat redraws its cards with their
 * diffs instead of a flat wall of text. The diffs below are the SAME strings the review panel serves for these
 * paths (fixture/workspace.ts), because they are the same change seen from the other side: the transcript is
 * where it was decided, the review is where it is read.
 *
 * FOUR conversations are fixtured: the agent holding a finished delta, which is the one a visitor is steered
 * to open from the board, and one per persona, the chats the window opens holding (fixture/openChats.ts),
 * so the rail's Personas cut opens onto work rather than onto an empty pane. Anything else still answers an
 * empty transcript, and the panel's empty state is honest there: those cards are a roster, not a recording.
 *
 * The three persona chats read differently from the coding one ON PURPOSE. Nothing in them touches a file:
 * they are a support queue, a launch thread and a payouts reconciliation, done through the accounts the
 * persona carries. That contrast is the whole argument for personas being in a workspace for coding agents,
 * and it is made by what the transcripts DO rather than by a sentence anywhere claiming it. */

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

/* A PERSONA CHAT, recorded for the pop-out's people-first view. The browser capture is intentionally one
 * compact artifact with two frames: enough evidence to trust the autonomous work without turning the
 * conversation into an operations dashboard. */
const MAYA_SUPPORT: AgentTranscript = {
    sessionId: `ses_01j9maya`,
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

/* GROWTH'S CHAT. Shorter than Maya's and deliberately so: it is the second row of a list of people, read far
 * more often than it is opened, and its job when it IS opened is to be recognisably a different kind of work
 * from the one above it, writing, posted through this persona's own accounts, with the owner holding the
 * final word on what goes out. */
const OWEN_LAUNCH: AgentTranscript = {
    sessionId: `ses_01j9owen`,
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

/* OPERATIONS' CHAT. The third kind again: reading two systems that disagree and coming back with the ONE
 * number a person has to decide about. It ends on a question rather than a result, because that is what this
 * persona's work usually ends on, and because a list of people whose every chat is finished says the wrong
 * thing about what they are for. */
const PRIYA_PAYOUTS: AgentTranscript = {
    sessionId: `ses_01j9priya`,
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
