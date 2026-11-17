import { stat } from "node:fs/promises";
import { join } from "node:path";
import { within } from "@intentic/base/async";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import type { Holding } from "../../conversations/actor/conversation-holdings.js";
import { dirtyPathsAcross } from "../../git/changes/changes.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";

// Detects a shell edit (sed -i, a heredoc, a mv) for hooks that only hear Edit|Write: a dirty file whose inode changed
// since the command started was changed by it. ctime, not mtime, since a rename keeps a file's mtime. `onDisk` is where
// this process stats the file; `path` is the agent's name, which isolation makes different.
export interface ShellEdit {
    readonly path: string;
    readonly onDisk: string;
}

// The turn's dirty files, both names each; injected since only the planner knows the worktree layout.
export type DirtyFiles = () => Promise<readonly ShellEdit[]>;

export interface ShellEditTracker {
    // Marks the command's start and nothing more, so the command never waits on a scan.
    readonly before: () => void;
    // What changed since the last `before`; without one, nothing is attributed to avoid a wrong blame.
    readonly changed: () => Promise<readonly ShellEdit[]>;
}

// The dirty files whose inode changed at or after `since`: what a command that started then wrote. Shared by the edit
// diagnostics (a Claude hook around each Bash call) and the verification ledger (frames, every runtime).
const changedSince = async (dirty: DirtyFiles, since: number): Promise<readonly ShellEdit[]> => {
    const files = await dirty().catch((): readonly ShellEdit[] => []);
    const touched = await Promise.all(
        files.map(async (edit) => {
            try {
                return (await stat(edit.onDisk)).ctimeMs >= since ? edit : undefined;
            } catch {
                // Deleted or unreadable: there is no file left to check, so there is nothing to attribute.
                return undefined;
            }
        }),
    );
    return touched.filter((edit) => edit !== undefined);
};

export const createShellEditTracker = (dirty: DirtyFiles, now: () => number = Date.now): ShellEditTracker => {
    let startedAt: number | undefined;
    return {
        before: () => {
            startedAt = now();
        },
        changed: async () => {
            const since = startedAt;
            startedAt = undefined;
            return since === undefined ? [] : changedSince(dirty, since);
        },
    };
};

// Milliseconds a turn reuses its checkout's repo list: discovery walks up to 10k dirs, and every shell command asks.
const REPOS_REUSED_MS = 60_000;

// The paths a turn's checkout has dirty, root-relative across its root repo and every nested one, with the repo list
// walked at most once per REPOS_REUSED_MS. What both readers around a command ask of the tree: the edit diagnostics
// above and the documents a command wrote (produced-documents.ts).
export const checkoutDirtyPaths = (root: string, now: () => number = Date.now): (() => Promise<string[]>) => {
    let repos: { readonly at: number; readonly list: Promise<string[]> } | undefined;
    return async () => {
        const at = now();
        if (repos === undefined || at - repos.at > REPOS_REUSED_MS) {
            repos = { at, list: discoverRepos(root) };
        }
        return dirtyPathsAcross(root, await repos.list);
    };
};

// A scan that has not answered by then attributes nothing, so a stuck git never holds the turn's proof or its end.
const SHELL_EDITS_BUDGET_MS = 10_000;

type TurnShellEdits = (since: number) => Promise<readonly string[]>;

// Each conversation's latest turn scanner, held so a parent's ledger over a child reads the same tree the child's own turn
// does (child-verification.ts): a spawned child under its own id, an in-process one through its parent's. 2026-11-17, the
// shinobi-society audit: a child's ledger had no scanner, so a child that edited only by shell (`sed -i`, a heredoc
// rewrite) read `no-code` to its parent.
export const TURN_SHELL_EDITS: Holding<TurnShellEdits> = { name: "turn shell edits" };

// What each command of a turn wrote, as the verification ledger reads it (agent-verification.ts `ShellEdits`): the
// checkout's dirty files changed since the command started, named as the agent names them (its root joined to the path).
// With `actors`, the scanner is filed under the turn's conversation, replacing its previous turn's.
export const turnShellEdits = (
    localCwd: string,
    effectiveCwd: string,
    actors?: { readonly conversations: Pick<ConversationActors, "holdings"> },
    turn?: { readonly conversationId?: string | undefined },
): TurnShellEdits => {
    const dirty = checkoutDirtyPaths(localCwd);
    const named: DirtyFiles = async () => (await dirty()).map((path) => ({ onDisk: join(localCwd, path), path: join(effectiveCwd, path) }));
    const scan: TurnShellEdits = async (since) =>
        (await within(changedSince(named, since), SHELL_EDITS_BUDGET_MS, [], { unref: true })).map((edit) => edit.path);
    if (actors !== undefined && turn?.conversationId !== undefined) {
        actors.conversations.holdings(TURN_SHELL_EDITS).hold(turn.conversationId, turn.conversationId, scan);
    }
    return scan;
};
