import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import type { FreshKind, FreshOf } from "@intentic/sandbox-contract/schemas/agent";
import type { Logger } from "pino";
import { agentRepoChanges, agentRepoWholeAnchor } from "../../conversations/land/agent-changes.js";
import { compactedSinceLastTurn, isIsolated, type PersistedAgent, worktreeOf } from "../../conversations/registry/agents-store.js";
import type { AgentWorktrees } from "../../conversations/worktrees/worktrees.js";
import { opt } from "../../opt.js";
import { FRESH_NOTE_HEADER, FRESH_NOTE_TITLE } from "../../sessions/vocabulary/prompt-envelope.js";

// A FRESH SESSION on another conversation's work (schemas/agent.ts FreshOfSchema): a code review, a test pass or a
// person's own ask, opened on that work as it stands with none of its messages. The daemon already treats it as the
// origin's child (cut from its work, landing back into it, folded under its card); this is what is particular to it.
// Whether one may open at all, and what it is told the work is: the changes as exact git ranges, since a review run at
// the workspace root misses every nested repo, and the cut committed the origin's work, so "uncommitted changes" and
// `@{upstream}` both read as nothing.

/** Why a fresh session cannot open on this origin, in words for the person who asked; undefined when it can. */
export const freshRefusal = (
    entryOf: (id: string) => PersistedAgent | undefined,
    conversationId: string,
    freshOf: FreshOf,
): string | undefined => {
    // The same opening sent again (a retry after an answer that never arrived) names the origin its entry already latched,
    // and is the resend the queue answers with what it did the first time, not a second start.
    const existing = entryOf(conversationId);
    if (existing !== undefined) {
        return existing.identity.fresh?.of === freshOf.conversationId
            ? undefined
            : "A fresh session opens as a new conversation, and this one already exists: start it in a new chat.";
    }
    const origin = entryOf(freshOf.conversationId);
    if (origin === undefined) {
        return `There is no conversation "${freshOf.conversationId}" whose work a fresh session could start from.`;
    }
    if (origin.archivedAt !== undefined) {
        return "That conversation is archived, so its work is not there to start from: reopen it first.";
    }
    if (!isIsolated(origin)) {
        return "That conversation works in the shared workspace, with no copy of its own to start from: review the workspace's changes in a chat of their own instead.";
    }
    if (origin.placement.runner !== undefined) {
        return "That conversation works on another machine, so its work is not here to start from.";
    }
    if (origin.placement.repos.length === 0) {
        return "That conversation has no work yet to start from.";
    }
    return undefined;
};

/** One repo's range: its id ("root" for the workspace root, else its folder under it) and the commit its work starts at. */
export interface FreshRange {
    readonly repo: string;
    readonly from: string;
}

/** What a fresh session is told of the work it started from. */
export interface FreshScope {
    readonly origin: { readonly id: string; readonly title: string | undefined };
    readonly kind: FreshKind;
    // Whether its checkout was cut from that work; false when the origin could no longer take it (archived, gone, on
    // another machine since), and the checkout is then the workspace's main line.
    readonly cut: boolean;
    // Each repo the origin changed, in its checkout's order; empty when it changed nothing.
    readonly ranges: readonly FreshRange[];
}

// Long enough never to be ambiguous in one repo, short enough to read in a command.
const short = (sha: string): string => sha.slice(0, 12);

/** The command that reads one range, run from the checkout's root. */
export const rangeCommand = ({ repo, from }: FreshRange): string =>
    repo === "root" ? `git diff ${short(from)}...HEAD` : `git -C ${repo} diff ${short(from)}...HEAD`;

const rangeLines = (ranges: readonly FreshRange[]): string[] =>
    ranges.map((range) => `- \`${rangeCommand(range)}\`${range.repo === "root" ? " (the workspace root)" : ""}`);

const originName = ({ id, title }: FreshScope["origin"]): string => (title === undefined ? `\`${id}\`` : `\`${id}\` ("${title}")`);

const KIND_LINE = {
    review: "You were opened to review this work: review these ranges and nothing else.",
    test: "You were opened to test this work: exercise what these ranges change, and report what you ran and what failed.",
    ask: undefined,
} as const satisfies { readonly [K in FreshKind]: string | undefined };

/** The note a fresh session's opening turn carries, and the turn after a compaction, since history cannot then. */
export const freshNote = (scope: FreshScope): TurnNote => {
    const lines = [FRESH_NOTE_HEADER, ""];
    if (!scope.cut) {
        lines.push(
            `This session was opened on the work of another conversation, ${originName(scope.origin)}, but that work could not be copied here: ` +
                "this checkout is the workspace's main line, without it. Say so if the task needs that work, rather than looking for it.",
        );
        return { title: FRESH_NOTE_TITLE, text: lines.join("\n") };
    }
    lines.push(
        `This session was opened on the work of another conversation, ${originName(scope.origin)}, as that work stood when it started, ` +
            "and with none of that conversation's messages: judge the work itself, not the reasoning that produced it.",
        "",
    );
    if (scope.ranges.length === 0) {
        lines.push("That conversation had changed nothing yet, so there is no diff to read: say so rather than reviewing something else.");
    } else {
        lines.push(
            "The work is exactly these ranges, each run from this checkout's root:",
            ...rangeLines(scope.ranges),
            "",
            'Here "the changes", "the diff" and "the work" mean these ranges: not `@{upstream}`, not the main branch, and not uncommitted ' +
                "changes, since the work was committed into this checkout when it was cut. Anything uncommitted is this session's own.",
        );
    }
    const kind = KIND_LINE[scope.kind];
    lines.push(
        ...(kind === undefined || scope.ranges.length === 0 ? [] : ["", kind]),
        "",
        "Edits made here go back into that conversation's work, not straight into the workspace. Nothing found here reaches that " +
            "conversation unless the person you are working with sends it there, so report what you find plainly in this chat.",
    );
    return { title: FRESH_NOTE_TITLE, text: lines.join("\n") };
};

/** What Codex's own reviewer is asked when `/review` names nothing: these ranges, since it reads none of the notes. */
export const freshReviewInstructions = (scope: FreshScope): string | undefined =>
    !scope.cut || scope.ranges.length === 0
        ? undefined
        : [
              "Review the code changes in these ranges, each run from the checkout's root:",
              ...rangeLines(scope.ranges),
              "They are the work this session was opened on. Review only these changes.",
          ].join("\n");

export interface FreshScopeDeps {
    readonly agents: { readonly entry: (id: string) => PersistedAgent | undefined };
    readonly agentWorktrees: AgentWorktrees;
    readonly logger: Pick<Logger, "warn">;
}

/**
 * What a fresh session is told of the work it started from, read now: the origin's whole output per repo, as its own
 * review lists it, for each repo this session carries. Undefined for any other conversation. A repo git cannot read is
 * left out and logged, never guessed at.
 */
export const freshScopeOf = async (deps: FreshScopeDeps, conversationId: string): Promise<FreshScope | undefined> => {
    const entry = deps.agents.entry(conversationId);
    const fresh = entry?.identity.fresh;
    if (entry === undefined || fresh === undefined) {
        return undefined;
    }
    const origin = deps.agents.entry(fresh.of);
    const named = { id: fresh.of, title: origin?.social.title?.text };
    const carried = new Set((worktreeOf(entry)?.repos ?? []).map(({ repo }) => repo));
    if (origin === undefined || !isIsolated(origin) || worktreeOf(entry)?.parent !== fresh.of) {
        return { origin: named, kind: fresh.kind, cut: false, ranges: [] };
    }
    const ranges: FreshRange[] = [];
    for (const composed of origin.placement.repos.filter(({ repo }) => carried.has(repo))) {
        try {
            if ((await agentRepoChanges(deps.agentWorktrees, origin, composed, "cumulative")).length > 0) {
                ranges.push({ repo: composed.repo, from: await agentRepoWholeAnchor(deps.agentWorktrees, origin, composed) });
            }
        } catch (error) {
            deps.logger.warn({ err: error, id: conversationId, origin: fresh.of, repo: composed.repo }, "fresh session: reading the origin's range failed");
        }
    }
    return { origin: named, kind: fresh.kind, cut: true, ranges };
};

/** What a fresh session's turn carries: the note on the turns that owe it, and Codex's review scope on every turn. */
export interface FreshFacts {
    readonly note?: TurnNote;
    readonly review?: string;
}

/**
 * Read for a fresh session's every turn, after its checkout is composed (which is what says whether it was cut): the
 * note only on the opening turn and the one after a compaction, like the context note, since history carries it between;
 * the review scope on all of them, since a `/review` typed later still means the same work. Undefined for any other
 * conversation.
 */
export const freshFactsIfAny = async (
    deps: FreshScopeDeps,
    conversationId: string | undefined,
    entry: Pick<PersistedAgent, "identity" | "compactedTurn"> | undefined,
    conversationTurns: number,
): Promise<FreshFacts | undefined> => {
    if (conversationId === undefined || entry?.identity.fresh === undefined) {
        return undefined;
    }
    const scope = await freshScopeOf(deps, conversationId);
    if (scope === undefined) {
        return undefined;
    }
    const due = conversationTurns === 0 || compactedSinceLastTurn(entry, conversationTurns);
    return { ...opt("note", due ? freshNote(scope) : undefined), ...opt("review", freshReviewInstructions(scope)) };
};
