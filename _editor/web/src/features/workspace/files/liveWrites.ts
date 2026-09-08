import type { ToolCallLocation, ToolKind } from "@intentic/sandbox-contract";
import { ref } from "vue";

// Live counterpart of changeOrigins: what a main-tree turn is writing right now (an isolated turn's worktree is
// irrelevant here). Read from the live tool_call stream, not persisted; best-effort, since the daemon's per-repo lock
// is the actual guard.

// Tools that change the tree; `execute` stays out, a Bash call reports no locations to honestly warn about.
const WRITING_TOOLS: ReadonlySet<ToolKind> = new Set<ToolKind>([`edit`, `delete`, `move`]);

// One turn's writes, keyed by the turn's start (not just the conversation) so a new turn begins empty rather than
// inheriting the last one's paths.
interface TurnWrites {
    readonly startedAt: number;
    readonly paths: ReadonlySet<string>;
}

const byConversation = ref<Record<string, TurnWrites>>({});

const NONE: ReadonlySet<string> = new Set();

// Folds one tool call's locations into the conversation's set. Caller must ensure it's a main-tree conversation: only
// it knows where the turn runs.
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
        // Strips a leading `./`: some adapters still emit it, and it would read as a repo literally named ".".
        paths.add(location.path.startsWith(`./`) ? location.path.slice(2) : location.path);
    }
    if (current?.startedAt === startedAt && paths.size === before) {
        return; // a re-edit of a file already recorded: no reactive churn for the panel
    }
    byConversation.value = { ...byConversation.value, [conversationId]: { startedAt, paths } };
};

// Paths the conversation's current turn has written. `startedAt` is the turn identity (Conversation.turnStartedAt);
// undefined means no turn running.
export const turnWrites = (conversationId: string, startedAt: number | undefined): ReadonlySet<string> => {
    if (startedAt === undefined) {
        return NONE;
    }
    const current = byConversation.value[conversationId];
    return current?.startedAt === startedAt ? current.paths : NONE;
};

// Which repo a path belongs to: longest matching id wins for nested repos (apps/web over apps). Unclaimed paths are the
// root repo; /work is itself one.
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
