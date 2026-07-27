import type { ToolCallLocation, ToolKind } from "@intentic/sandbox-contract";
import { ref } from "vue";

/* WHAT A MAIN-TREE TURN IS WRITING RIGHT NOW — the live counterpart of changeOrigins, which answers the same
 * question about work that has already landed. An isolated turn writes its own worktree and is nobody's
 * business here; a MAIN-TREE conversation writes the very files the Changes panel is about to commit, and
 * that is the one overlap worth a word to the user.
 *
 * The daemon cannot help: only isolated turns get a fleet-registry entry (agent.routes.ts returns early
 * without `isolated`), so a main-tree turn exists nowhere but the stream that is carrying it. What it does
 * carry is `locations` on every tool_call — already workspace-root-relative — so the paths ARE the signal,
 * and they arrive as the writes happen rather than after them.
 *
 * Deliberately BEST-EFFORT, exactly like follow-along: a turn a different browser started and this one never
 * attached to leaves no trace here. That is affordable because nothing gates on this — it decorates a commit
 * the user may make either way, and the daemon's per-repo lock (git.routes.ts) is what actually keeps a
 * commit and an agent's land from interleaving. A missed advisory costs a word, not a repo. */

// Tool categories that change the tree. `read`/`search`/`think` and friends touch nothing, and `execute` is
// deliberately out: a Bash call reports no locations, so admitting it would mean warning about every repo or
// none — and "none" is what a tool with no location can honestly claim.
const WRITING_TOOLS: ReadonlySet<ToolKind> = new Set<ToolKind>([`edit`, `delete`, `move`]);

// One turn's writes. Keyed by the turn's start rather than just the conversation, so the previous turn's paths
// cannot linger into the next one: a conversation that starts writing again begins from an empty set the
// moment its first write lands, instead of warning about a repo this turn hasn't touched yet.
interface TurnWrites {
    readonly startedAt: number;
    readonly paths: ReadonlySet<string>;
}

const byConversation = ref<Record<string, TurnWrites>>({});

const NONE: ReadonlySet<string> = new Set();

// Fold one tool call's locations into the conversation's set. Called for main-tree conversations only — the
// caller owns that test, because it is the caller that knows where the turn runs.
export const recordTurnWrite = (
    conversationId: string,
    startedAt: number,
    call: { readonly category: ToolKind; readonly locations?: readonly ToolCallLocation[] },
): void => {
    if (!WRITING_TOOLS.has(call.category) || call.locations === undefined || call.locations.length === 0) {
        return;
    }
    const current = byConversation.value[conversationId];
    const paths = new Set(current?.startedAt === startedAt ? current.paths : []);
    const before = paths.size;
    for (const location of call.locations) {
        // The wire contract is root-relative already; an explicit `./` lead is the one shape adapters still
        // emit, and it would otherwise read as a repo directory literally named ".".
        paths.add(location.path.startsWith(`./`) ? location.path.slice(2) : location.path);
    }
    if (current?.startedAt === startedAt && paths.size === before) {
        return; // a re-edit of a file already recorded — no reactive churn for the panel
    }
    byConversation.value = { ...byConversation.value, [conversationId]: { startedAt, paths } };
};

// The paths this conversation's CURRENT turn has written. `startedAt` is the turn identity the caller holds
// (Conversation.turnStartedAt); undefined means no turn is running, which is no writes by definition.
export const turnWrites = (conversationId: string, startedAt: number | undefined): ReadonlySet<string> => {
    if (startedAt === undefined) {
        return NONE;
    }
    const current = byConversation.value[conversationId];
    return current?.startedAt === startedAt ? current.paths : NONE;
};

// Which repo a root-relative path belongs to. Nested repos can nest further, so the LONGEST matching id wins —
// a path under `apps/web` belongs to `apps/web`, not to `apps`. Everything else is the root repo, which is
// also the honest answer for a path no repo claims: /work is itself a repo.
export const repoOfPath = (path: string, repos: ReadonlySet<string>): string => {
    let best = `root`;
    let bestLength = -1;
    for (const repo of repos) {
        if (path.startsWith(`${repo}/`) && repo.length > bestLength) {
            best = repo;
            bestLength = repo.length;
        }
    }
    return best;
};
