import type { TodoItem, TurnNote } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { changedFiles } from "../../git/changes/changes.js";
import { workspaceRelative } from "../../rules/turn-ending.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import { readTaskStore, type StoredTask, taskStoreDir } from "../run/task-store.js";
import type { VerificationStanding } from "../verification/agent-verification.js";

/* WHERE THE WORK STANDS, MEASURED, for the session that has to pick it up without having been there.
 *
 * A turn seeded from the record (a provider or account switch, a forgotten session, a spent allowance moved to
 * another account) gets the conversation's transcript folded into its opening message (runtime-history.ts). That
 * envelope carries what was SAID. It cannot carry what is TRUE: whether the files the last turn said it edited are
 * on the branch, whether anything proved them, and which of the steps the agent listed for itself it crossed
 * off. A model handed only the words fills those gaps by recall, and recall across a hand-off is where an agent
 * announces a finished task with three items still open, or re-does the two it had already done.
 *
 * So this note says those three things from the sandbox's own readings, never from the model's account of
 * itself: git for the branch, the turn's proof ledger for the verification, the CLI's own task store for the
 * checklist. Pointers rather than pastes throughout (the paths, the check's name, the item's words), since the
 * next session can read any of them itself and a brief that quotes a diff has stopped being a brief. Capped
 * at roughly the size of a sub-agent's report, which is the size this kind of hand-off is known to work at:
 * the newest turns in the envelope carry the decisions, this carries the state, and neither is an archive.
 *
 * Rides the turn as a preamble note (turn-preamble.ts): verbatim to the model, collapsed in the chat, in the
 * record. The history envelope is left untouched, because it is parsed back apart when the session file is
 * read, and a section inside it would be read back as somebody's message. */

export const HANDOFF_STATE_NOTE_TITLE = "Where the work stands";
const HEADER = "## Where the work stands";

// How many paths a repository's line may name before the rest are counted. Forty is a screen of paths, which
// is more than a reader scans and enough that the model can grep the branch for the ones it wants.
const PATHS_PER_REPO = 40;
// How many checklist items are worth carrying whole. A list longer than this is a plan, not a checklist, and
// the model re-reads its own plan from the envelope.
const CHECKLIST_ITEMS = 40;
// The whole note's ceiling, in characters, about 1,500 tokens. Paths are what is dropped first when it is hit:
// the counts and the verdicts are the facts, the paths are where to look for them.
const NOTE_CHAR_CAP = 6_000;

export interface HandoffState {
    readonly conversationId: string;
    /* The proof ledger of the turn that is being handed off, when it is THIS turn's death that hands it off
     * (a spent allowance keeps it on the held entry). Absent on a switch between turns, where the last turn's
     * ledger is gone and only the registry's failed-check name survives. */
    readonly standing?: VerificationStanding | undefined;
    // The fold's last snapshot of the checklist, the fallback when no session store is readable.
    readonly checklist?: readonly TodoItem[] | undefined;
    // The provider session being retired, whose task store is the authoritative checklist.
    readonly retiredSessionId?: string | undefined;
    readonly now?: number;
}

export type HandoffStateDeps = Pick<Services, "agents" | "agentWorktrees" | "workspace" | "logger">;

interface RepoReading {
    readonly repo: string;
    readonly branch: string | undefined;
    readonly paths: readonly string[];
    readonly additions: number;
    readonly deletions: number;
    readonly staged: number;
    readonly unstaged: number;
    readonly conflicted: number;
}

// One repository's changes, optionally only the paths a scope names (the main tree, where everything else
// on the tree is other people's work). A repository git cannot read answers nothing rather than failing the note.
const readRepo = async (dir: string, repo: string, scope: ReadonlySet<string> | undefined): Promise<RepoReading | undefined> => {
    try {
        const state = await changedFiles(dir);
        const within = (path: string): boolean => scope === undefined || scope.has(path);
        const staged = state.staged.filter((change) => within(change.path));
        const unstaged = state.unstaged.filter((change) => within(change.path));
        const conflicted = state.conflicted.filter((change) => within(change.path));
        const rows = [...conflicted, ...staged, ...unstaged];
        return {
            repo,
            branch: state.branch,
            paths: [...new Set(rows.map((change) => change.path))],
            additions: rows.reduce((total, change) => total + (change.additions ?? 0), 0),
            deletions: rows.reduce((total, change) => total + (change.deletions ?? 0), 0),
            staged: staged.length,
            unstaged: unstaged.length,
            conflicted: conflicted.length,
        };
    } catch {
        return undefined;
    }
};

/* Which repository each edited path belongs to, on the MAIN tree: the longest repository id that prefixes it,
 * else the root. Edited paths arrive as the tools saw them, absolute or workspace-relative, so they are made
 * relative to the workspace first and to their repository second. */
const groupByRepo = (paths: readonly string[], repos: readonly string[], root: string): Map<string, Set<string>> => {
    const grouped = new Map<string, Set<string>>();
    const byLength = [...repos].sort((a, b) => b.length - a.length);
    for (const raw of paths) {
        const relative = workspaceRelative(raw, root);
        const repo = byLength.find((id) => relative === id || relative.startsWith(`${id}/`)) ?? "root";
        const inRepo = repo === "root" ? relative : relative.slice(repo.length + 1);
        (grouped.get(repo) ?? grouped.set(repo, new Set()).get(repo))?.add(inRepo);
    }
    return grouped;
};

interface TreeReading {
    readonly isolated: boolean;
    readonly repos: readonly RepoReading[];
    readonly retired: readonly string[];
}

// An isolated conversation's own checkouts, every repository in its composition; a retired checkout is named
// rather than read, the branch holds its work and the next turn re-attaches it.
const readBranch = async (deps: HandoffStateDeps, id: string, composition: readonly { readonly repo: string }[]): Promise<TreeReading> => {
    const repos: RepoReading[] = [];
    const retired: string[] = [];
    for (const composed of composition) {
        if (!(await deps.agentWorktrees.attached(id, composed.repo))) {
            retired.push(composed.repo);
            continue;
        }
        const reading = await readRepo(deps.agentWorktrees.worktreeDir(id, composed.repo), composed.repo, undefined);
        if (reading !== undefined) {
            repos.push(reading);
        }
    }
    return { isolated: true, repos, retired };
};

// The main tree: only what the last turn touched is this conversation's, and only a ledger can say what that
// was. With none, the tree is everybody's and the note says nothing about it.
const readMainTree = async (deps: HandoffStateDeps, edited: readonly string[]): Promise<TreeReading> => {
    const root = deps.workspace.root;
    const repos: RepoReading[] = [];
    if (edited.length > 0) {
        const grouped = groupByRepo(edited, await discoverRepos(root).catch(() => []), root);
        for (const [repo, scope] of grouped) {
            const reading = await readRepo(deps.agentWorktrees.mainDir(repo), repo, scope);
            if (reading !== undefined) {
                repos.push(reading);
            }
        }
    }
    return { isolated: false, repos, retired: [] };
};

const readTree = async (deps: HandoffStateDeps, state: HandoffState): Promise<TreeReading> => {
    const entry = deps.agents.entry(state.conversationId);
    return entry?.branch !== undefined ? readBranch(deps, entry.id, entry.repos) : readMainTree(deps, state.standing?.paths ?? []);
};

// The checklist as the CLI's own store has it for the retired session, else as the fold last saw it. The
// store wins because the fold cannot see an update to a task made in an earlier turn (task-store.ts).
const readChecklist = async (deps: HandoffStateDeps, state: HandoffState): Promise<readonly { readonly text: string; readonly status: StoredTask["status"] }[]> => {
    if (state.retiredSessionId !== undefined && /^[\w-]+$/.test(state.retiredSessionId)) {
        const stored = await readTaskStore(taskStoreDir(deps.workspace.root, state.retiredSessionId));
        if (stored.length > 0) {
            return stored.map((task) => ({ text: task.subject, status: task.status }));
        }
    }
    return (state.checklist ?? []).map((item) => ({ text: item.content, status: item.status }));
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const repoLine = (reading: RepoReading, withPaths: boolean): string => {
    if (reading.paths.length === 0) {
        return `- \`${reading.repo}\`: no changes`;
    }
    const sides = [
        ...(reading.conflicted > 0 ? [`${reading.conflicted} conflicted`] : []),
        ...(reading.staged > 0 ? [`${reading.staged} staged`] : []),
        ...(reading.unstaged > 0 ? [`${reading.unstaged} unstaged`] : []),
    ].join(", ");
    const head = `- \`${reading.repo}\`: ${plural(reading.paths.length, "file")} changed (+${reading.additions} −${reading.deletions}; ${sides})`;
    if (!withPaths) {
        return head;
    }
    const shown = reading.paths.slice(0, PATHS_PER_REPO);
    const rest = reading.paths.length - shown.length;
    return `${head}\n  ${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
};

const verificationLine = (standing: VerificationStanding | undefined, failedCheck: string | undefined): string | undefined => {
    if (standing !== undefined) {
        switch (standing.state) {
            case "verified":
                return `- Verification: passed, \`${standing.check ?? "a check"}\` ran green after the last edit.`;
            case "failing":
                return `- Verification: FAILING, \`${standing.check ?? "the last check"}\` was red when the turn stopped. Fix that before anything else.`;
            case "unproven":
                return "- Verification: unproven, no check ran after the last edit. Run the workspace's checks on the paths above before building on them.";
            case "no-code":
                return undefined;
        }
    }
    return failedCheck === undefined ? undefined : `- Verification: the end-of-turn check \`${failedCheck}\` was still failing when the last turn ended.`;
};

const stamp = (now: number): string => {
    const date = new Date(now);
    const hh = String(date.getUTCHours()).padStart(2, "0");
    const mm = String(date.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm} UTC`;
};

type ChecklistRow = { readonly text: string; readonly status: StoredTask["status"] };

const treeSection = (tree: TreeReading, withPaths: boolean): string | undefined => {
    if (tree.repos.length === 0 && tree.retired.length === 0) {
        return undefined;
    }
    const title = tree.isolated ? "### On this conversation's own branch" : "### On the shared tree, the paths the last turn edited";
    const lines = tree.repos.map((reading) => repoLine(reading, withPaths));
    if (tree.retired.length > 0) {
        lines.push(`- ${tree.retired.map((repo) => `\`${repo}\``).join(", ")}: checkout retired; the branch holds the work and the next turn re-attaches it.`);
    }
    return `${title}\n${lines.join("\n")}`;
};

const pathList = (paths: readonly string[], withPaths: boolean): string => {
    if (!withPaths) {
        return plural(paths.length, "file");
    }
    const shown = paths.slice(0, PATHS_PER_REPO);
    const rest = paths.length - shown.length;
    return `${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
};

const lastTurnSection = (edited: readonly string[], verification: string | undefined, withPaths: boolean): string | undefined => {
    const lines = [...(edited.length > 0 ? [`- Edited by the interrupted turn: ${pathList(edited, withPaths)}`] : []), ...(verification === undefined ? [] : [verification])];
    return lines.length === 0 ? undefined : `### The last turn\n${lines.join("\n")}`;
};

const checklistSection = (checklist: readonly ChecklistRow[]): string | undefined => {
    if (checklist.length === 0) {
        return undefined;
    }
    const shown = checklist.slice(0, CHECKLIST_ITEMS);
    const open = checklist.filter((item) => item.status !== "completed").length;
    const items = shown.map((item) => `- [${item.status === "completed" ? "x" : " "}] ${item.text}${item.status === "in_progress" ? " (was in progress)" : ""}`);
    const rest = checklist.length - shown.length;
    const carry = open === 0 ? "Every item is done; do not redo them." : `Re-create the ${plural(open, "open item")} in your own task list before continuing, and do not redo the ones marked done.`;
    return `### The checklist the previous session kept (${open} of ${checklist.length} open)\n${items.join("\n")}${rest > 0 ? `\n- … +${rest} more` : ""}\n${carry}`;
};

const render = (tree: TreeReading, edited: readonly string[], verification: string | undefined, checklist: readonly ChecklistRow[], now: number, withPaths: boolean): string =>
    [
        `${HEADER}\n\nMeasured by the sandbox at ${stamp(now)}, not recalled: trust it over memory. Read the diff in the tree for detail rather than re-deriving it.`,
        treeSection(tree, withPaths),
        lastTurnSection(edited, verification, withPaths),
        checklistSection(checklist),
    ]
        .filter((section): section is string => section !== undefined)
        .join("\n\n");

// Whether the readings add up to anything worth a note: a tree with changes on it, a retired checkout to
// name, a turn that edited or proved something, or a list with items on it.
const measured = (tree: TreeReading, edited: readonly string[], verification: string | undefined, checklist: readonly ChecklistRow[]): boolean =>
    tree.repos.some((reading) => reading.paths.length > 0) || tree.retired.length > 0 || edited.length > 0 || verification !== undefined || checklist.length > 0;

// The note at the cap: paths go first, and a note still over it after that is cut where it stands.
const capped = (full: () => string, terse: () => string): string => {
    const text = full().length > NOTE_CHAR_CAP ? terse() : full();
    return text.length > NOTE_CHAR_CAP ? `${text.slice(0, NOTE_CHAR_CAP)}\n…` : text;
};

/* The note, or nothing when there is nothing measured to say: a first hand-off on a conversation that edited
 * nothing, kept no list and stands under no check. Never rejects: a reading that fails costs the note a line,
 * not the turn its start. */
export const handoffStateNote = async (deps: HandoffStateDeps, state: HandoffState): Promise<TurnNote | undefined> => {
    const now = state.now ?? Date.now();
    try {
        const [tree, checklist] = await Promise.all([readTree(deps, state), readChecklist(deps, state)]);
        const edited = (state.standing?.paths ?? []).map((path) => workspaceRelative(path, deps.workspace.root));
        const verification = verificationLine(state.standing, deps.agents.entry(state.conversationId)?.unfinished?.check);
        if (!measured(tree, edited, verification, checklist)) {
            return undefined;
        }
        return {
            title: HANDOFF_STATE_NOTE_TITLE,
            text: capped(
                () => render(tree, edited, verification, checklist, now, true),
                () => render(tree, edited, verification, checklist, now, false),
            ),
        };
    } catch (error) {
        deps.logger.warn({ err: error, conversationId: state.conversationId }, "hand-off state: the note could not be measured, the turn starts without it");
        return undefined;
    }
};
