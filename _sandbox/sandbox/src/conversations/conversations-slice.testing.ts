import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { IN_MEMORY } from "@intentic/base/sqlite";
import { askRoleModel, roleModelIsSet } from "../agent/models/role-model.js";
import { streamAgent } from "../agent/run/stream-agent.js";
import { cancelFamily, familyOf } from "../agent/subagents/children.js";
import { cancelWatchersFor } from "../agent/verification/watchers.js";
import { turnDoors } from "../agent/run/turn/turn-doors.js";
import type { SliceFakeContext } from "../harness/slice-fake.testing.js";
import { claudeStoreOf } from "../sessions/session-store.js";
import { openConversationsDb } from "../store/conversations-db.js";
import { conversationUnits } from "../store/conversation-units.js";
import { fleetStoreOver, memoryFleet } from "./registry/agents-registry.testing.js";
import { noIsolation } from "./worktrees/isolation.testing.js";
import { createBranchCheckouts } from "./worktrees/branches/branch-checkouts.js";
import { createLogger } from "../logger.js";
import { parkedCards } from "./actor/parked-cards.js";
import { sqliteAgentsStore } from "./registry/agents-store.js";
import type { ConversationsSlice } from "./conversations-slice.js";
import { registryDrafts } from "./drafts/composer-drafts.js";

// The conversations slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

// Never-created path under tmpdir, absent everywhere; naming the real /work would vary by machine.
const ABSENT_MAIN = join(tmpdir(), "intentic-absent-main");

// What the branch checkouts below say goes nowhere: no suite reads it.
const SILENT = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

// Where a conversation's checkout lives, shared by the worktree fake and the scope composed from it.
const conversationDir = (id: string): string => `${HISTORY_ROOT}/worktrees/${id}`;

// Each conversation's checkout at its place under HISTORY_ROOT, none of them on disk, and a main checkout that exists
// nowhere; worktree git stays stubbed. A factory, so each suite's services hold their own.
const absentWorktrees = () =>
    ({
        conversationDir,
        worktreeDir: (id, repo) => (repo === "root" ? `${HISTORY_ROOT}/worktrees/${id}` : `${HISTORY_ROOT}/worktrees/${id}/${repo}`),
        mainDir: (repo) => (repo === "root" ? ABSENT_MAIN : join(ABSENT_MAIN, repo)),
        presence: async () => "gone",
        // Live checkout standing on its own branch: routes read the worktree path, the steady state these fakes
        // model, and nothing has strayed off it.
        attached: async () => true,
        elsewhere: async () => [],
        snapshot: async () => [{ repo: "root", base: "a".repeat(40) }],
        sessionStore: (entry) => claudeStoreOf(ABSENT_MAIN, HISTORY_ROOT, entry),
        ensure: async (id) => ({
            cwd: `${HISTORY_ROOT}/worktrees/${id}`,
            branch: `agent/${id}`,
            repos: [{ repo: "root", base: "a".repeat(40) }],
            fence: undefined,
            elsewhere: [],
        }),
        remove: async () => {},
        retire: async () => {},
        reapRepoCheckout: async () => {},
        prune: async () => {},
        withRepoLock: (_repo, task) => task(),
        repoBusy: () => false,
        // Every checkout still reaches its repository: nothing to re-link.
        relink: async () => [],
    }) satisfies ConversationsSlice["agentWorktrees"];

export const conversationsSliceFake = (context: SliceFakeContext) => {
    // Real registry over an in-memory conversations database, with every conversation's directory under the suite's own
    // history root.
    const conversationsDb = openConversationsDb(IN_MEMORY);
    const units = conversationUnits(context.historyRoot, { ...sqliteAgentsStore(conversationsDb), recreated: false });
    const { agents, conversations } = memoryFleet(fleetStoreOver(conversationsDb, units));
    // Real checkouts of branches, of whatever workspace the suite's services name (read at each call), so a suite on a
    // real repository reads a branch the way the daemon does. Under a history root of these services' own, never
    // written until a branch is checked out: the default test history root is every suite's, and a checkout another
    // suite left there under the same names would answer for this one's repository. No lock to queue on.
    const branchCheckouts = createBranchCheckouts({
        historyRoot: join(context.historyRoot, "branch-checkouts", randomUUID()),
        worktrees: {
            withRepoLock: (_repo, task) => task(),
            mainDir: (repo) => (repo === "root" ? context.self().workspace.root : join(context.self().workspace.root, repo)),
        },
        logger: SILENT,
    });
    return {
        agents,
        conversations,
        // The cards a suite's turns park on, over the same actors, so a reply through the routes finds them.
        cards: parkedCards(conversations),
        conversationsDb,
        conversationUnits: units,
        // Inert: every dispatched turn files what it was told, and no suite here reads it back.
        promptRecord: { record: async () => {}, of: async () => undefined },
        // Inert: every fire path writes an in-flight entry and clears it; nothing here resumes.
        turnJournal: {
            list: async () => [],
            recordTurn: async () => {},
            recordFire: async () => {},
            clearTurn: async () => {},
            clearFire: async () => {},
        },
        agentWorktrees: absentWorktrees(),
        branchCheckouts,
        // The real store under the suite's own history root, telling the same registry as the daemon's does.
        drafts: registryDrafts(context.historyRoot, agents, (error) => {
            throw error;
        }),
        // Composed from the same two lookups the daemon uses, so an unscoped read is the shared tree just as in
        // production. Read through the finished services, so redirecting `workspace` moves the file routes with it.
        workspaceScope: {
            get main() {
                return context.self().workspace.root;
            },
            entry: (id) => context.self().agents.entry(id),
            worktreeDir: conversationDir,
            // Through the finished services too, so a suite that stands in its own checkouts is read through them.
            get branches() {
                return context.self().branchCheckouts;
            },
        },
        // Namespace isolation off, what a container without CAP_SYS_ADMIN gets: turns run straight in the worktree
        // path. isolation.integration.test.ts covers the plan when it IS available.
        turnIsolation: noIsolation(WORKSPACE_ROOT),
        // No agent has landed anything, so every changed file is the user's and `identify` has nobody to resolve.
        agentOrigins: { forRepo: async () => ({}), identify: () => ({}), metrics: () => ({}) },
        // The engine's own doors over these services, as composition binds them.
        turns: turnDoors(context.self, (input, signal) => streamAgent(context.self(), input, signal)),
        turnEngine: { askRoleModel, roleModelIsSet, familyOf, cancelFamily, cancelWatchersFor },
    } satisfies Partial<ConversationsSlice>;
};
