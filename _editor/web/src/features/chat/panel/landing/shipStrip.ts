import { isHomeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { type AgentStanding, turnInFlight } from "@intentic/sandbox-contract/models/agent-standing";
import { changeIsFrom, originsOfChange } from "@intentic/sandbox-contract/schemas/git/git-scope";
import type { GitChange, RepoChanges } from "@intentic/sandbox-contract/schemas/git/git";
import type { LandedMessageDraft } from "@intentic/sandbox-contract/schemas/agents";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import type { SyncTarget } from "../../../../models/changes/useChanges";
import type { SessionCommits } from "../../../../models/changes/sessionCommits";
import { askingModel, draftRunning } from "../../../../models/changes/landedDraft";
import { ahead, behind, syncable, unpublished } from "../../../../models/workspace/push/outgoingWork";

// WHAT A CHAT SAYS ABOUT ITS WORK ONCE IT HAS LANDED, in the strip above its composer (ChatShipStrip): commit it, then
// push it, the two presses that take landed work the rest of the way without a trip to the Changes panel. The commit is
// the panel's lit From chip and its Commit press in one: this session's files staged and recorded under the message
// drafted at land time. It is offered only when it would record exactly that, and otherwise the strip says why and
// sends the reader to the panel, where the rest of the tree is in view. The push sends the branches this chat committed
// on, which git cannot narrow to one commit, so the strip counts what else goes with it.

export interface ShipReader {
    // A maintainer: the daemon refuses a commit or a push from anyone below, so nobody else is offered one.
    readonly canShip: boolean;
    // Plain words, whose saves are never partial (the save panel has no index), so a commit of one chat's files is not theirs.
    readonly maker: boolean;
    // The turn is streaming in this window, which a roster frame may not have caught up with yet.
    readonly streaming: boolean;
    // The chat is another sandbox's, whose tree this tab does not commit in.
    readonly elsewhere: boolean;
}

export type ShipAgent = Pick<FleetAgent, `id` | `archivedAt`> & AgentStanding;

/**
 * Whether the chat may say anything about committing and pushing its work at all: a settled chat of this box, read by a
 * maintainer in a developer's words. Not a home conversation, which commits its own lands; not while a turn is going,
 * whose work is not done.
 */
export const shipsFrom = (agent: ShipAgent | undefined, reader: ShipReader): agent is ShipAgent =>
    agent !== undefined &&
    reader.canShip &&
    !reader.maker &&
    !reader.streaming &&
    !reader.elsewhere &&
    agent.archivedAt === undefined &&
    !isHomeConversationId(agent.id) &&
    agent.status !== `draft` &&
    !turnInFlight(agent);

/** Where the commit message stands: written at land time, still being written, or not coming (the reader types one). */
export type CommitDraft =
    | { readonly state: `written`; readonly text: string; readonly subject: string }
    | { readonly state: `drafting`; readonly model: string | undefined }
    | { readonly state: `missing`; readonly reason: string | undefined };

/** Why the commit is left to the Changes panel: a commit here would take more than this chat's work, or git would refuse it. */
export type CommitBlock = `conflicts` | `shared` | `staged`;

/** Which verb the push is: the Changes panel's own bar reading (syncPress.ts) over this chat's repositories alone. */
export type PushVerb = `push` | `sync` | `publish`;

export type ShipStrip =
    | { readonly kind: `commit`; readonly repos: readonly string[]; readonly files: number; readonly draft: CommitDraft }
    | { readonly kind: `blocked`; readonly files: number; readonly block: CommitBlock }
    | { readonly kind: `committing`; readonly files: number }
    | {
          readonly kind: `push`;
          readonly verb: PushVerb;
          readonly targets: readonly SyncTarget[];
          // Commits the push sends, all of them, and how many of those this chat did not make.
          readonly commits: number;
          readonly others: number;
          // The last push of these repositories was refused, and its verdict still stands.
          readonly refused: boolean;
      }
    | { readonly kind: `pushing` }
    | { readonly kind: `pushed` };

export interface ShipFacts {
    // The conversation whose work this is, as `RepoChanges.origins` names it.
    readonly id: string;
    // The shared tree's repositories as last read; one git could not read says nothing either way.
    readonly repos: readonly RepoChanges[];
    // Repositories with a commit running, this tab's or another's.
    readonly committing: readonly string[];
    // The commit message its last land drafted (landedCommitMessage), and the story of it being drafted.
    readonly message: string | undefined;
    readonly draft: LandedMessageDraft | undefined;
    // What this chat committed and has not seen pushed (sessionCommits.ts).
    readonly commits: SessionCommits | undefined;
    // The push flow, by the repositories each of its moments is about: a push in flight, one that just went through,
    // and a refusal still standing.
    readonly push: { readonly running: readonly string[]; readonly pushed: readonly string[]; readonly refused: readonly string[] };
}

const SIDES = [`conflicted`, `staged`, `unstaged`] as const;

const rowsOf = (repo: RepoChanges): readonly GitChange[] => SIDES.flatMap((side) => repo[side]);

const readable = (repos: readonly RepoChanges[]): readonly RepoChanges[] => repos.filter((repo) => repo.error === undefined);

/** How many distinct files of the session's the tree holds, across every side (a file staged and edited again is one). */
const sessionFiles = (id: string, repos: readonly RepoChanges[]): number =>
    repos.reduce((total, repo) => {
        const origins = repo.origins ?? {};
        return total + new Set(rowsOf(repo).filter((row) => changeIsFrom(row, id, origins)).map((row) => row.path)).size;
    }, 0);

/** Why a commit of the session's files alone cannot be made from here, or undefined when it can. */
const blockOf = (id: string, repos: readonly RepoChanges[]): CommitBlock | undefined => {
    // A conflict blocks every commit in its repository, and staging one would mark it resolved for the owner.
    if (repos.some((repo) => repo.conflicted.length > 0)) {
        return `conflicts`;
    }
    // Another session landed one of the same files: the commit would carry its lines under this chat's name.
    if (repos.some((repo) => rowsOf(repo).some((row) => changeIsFrom(row, id, repo.origins ?? {}) && originsOfChange(row, repo.origins ?? {}).length > 1))) {
        return `shared`;
    }
    // A commit records the whole index: anything staged that is not this session's (or not listed, past the daemon's
    // row budget) would go in with it.
    const foreignStaged = (repo: RepoChanges): boolean =>
        (repo.truncated?.staged ?? 0) > 0 || repo.staged.some((row) => !changeIsFrom(row, id, repo.origins ?? {}));
    return repos.some(foreignStaged) ? `staged` : undefined;
};

/** The message, as the commit press reads it: the drafted one, the wait for it, or the reader's to write. */
export const commitDraftOf = (message: string | undefined, draft: LandedMessageDraft | undefined): CommitDraft => {
    if (message !== undefined && message.trim() !== ``) {
        return { state: `written`, text: message, subject: message.split(`\n`, 1)[0]!.trim() };
    }
    // Written but not yet on the card (the two arrive on one push, but a roster frame can split them) still reads as
    // the wait, rather than flashing the box for the frames between.
    if (draftRunning(draft) || draft?.outcome === `written`) {
        return { state: `drafting`, model: askingModel(draft) };
    }
    return { state: `missing`, reason: draft?.outcome === `failed` ? draft.reason : undefined };
};

const overlaps = (repos: readonly string[], ours: readonly string[]): boolean => repos.some((repo) => ours.includes(repo));

/** The push this chat's commits are waiting on, read off the repositories they went into. */
const pushOf = (commits: SessionCommits, repos: readonly RepoChanges[], refused: readonly string[]): ShipStrip | undefined => {
    const sending = readable(repos).filter((repo) => commits[repo.repo] !== undefined && syncable(repo) && (ahead(repo) > 0 || unpublished(repo)));
    if (sending.length === 0) {
        return undefined;
    }
    const total = sending.reduce((sum, repo) => sum + ahead(repo), 0);
    // Never more than the branch is ahead by: a commit of ours since amended or squashed is not counted twice.
    const ours = sending.reduce((sum, repo) => sum + Math.min(commits[repo.repo] ?? 0, ahead(repo)), 0);
    const pulls = sending.some((repo) => behind(repo) > 0);
    return {
        kind: `push`,
        verb: pulls ? `sync` : total === 0 ? `publish` : `push`,
        targets: sending.map((repo) => ({ repo: repo.repo, pull: behind(repo) > 0, push: true })),
        commits: total,
        others: total - ours,
        refused: overlaps(refused, sending.map((repo) => repo.repo)),
    };
};

/** The strip to draw for a chat whose work has landed, or undefined for none. */
export const shipStripOf = (facts: ShipFacts): ShipStrip | undefined => {
    const repos = readable(facts.repos);
    const files = sessionFiles(facts.id, repos);
    if (files > 0) {
        const holding = repos.filter((repo) => rowsOf(repo).some((row) => changeIsFrom(row, facts.id, repo.origins ?? {})));
        const names = holding.map((repo) => repo.repo);
        if (overlaps(facts.committing, names)) {
            return { kind: `committing`, files };
        }
        const block = blockOf(facts.id, holding);
        return block === undefined
            ? { kind: `commit`, repos: names, files, draft: commitDraftOf(facts.message, facts.draft) }
            : { kind: `blocked`, files, block };
    }
    if (facts.commits === undefined) {
        return undefined;
    }
    const committedIn = Object.keys(facts.commits);
    if (overlaps(facts.push.running, committedIn)) {
        return { kind: `pushing` };
    }
    // Ahead of the push's own rescan, which still lists the commits it just sent.
    if (overlaps(facts.push.pushed, committedIn)) {
        return { kind: `pushed` };
    }
    return pushOf(facts.commits, repos, facts.push.refused);
};

/** Whether nothing the chat committed is still owed a remote: every repository it committed in is read, and has none or is level with it. */
export const sessionCommitsSettled = (commits: SessionCommits, repos: readonly RepoChanges[]): boolean =>
    Object.keys(commits).every((name) => {
        const repo = repos.find((entry) => entry.repo === name);
        return repo !== undefined && repo.error === undefined && (!syncable(repo) || (ahead(repo) === 0 && !unpublished(repo)));
    });
