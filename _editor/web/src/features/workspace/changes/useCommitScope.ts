import type { GitDiffSide, LandedMessage, LandedMessageDraft, RepoChanges } from "@intentic/sandbox-contract";
import { sandboxRef } from "@intentic/extension-api";
import { formatElapsed } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { useAgents } from "../../agents/fleet/useAgents";
import { currentAction, unfinishedMark } from "../../agents/fleet/agentStatus";
import { useChat } from "../../chat/run/useChat";
import { commitMessageOf, draftRunning, landedMessage, summarizeOrigins } from "./changeOrigins";
import { nameCommitAfter, namedAfter } from "./commitMessage";
import { type CommitScope, defaultScope, inScope, sameScope, scopeCommit, scopeFiles, scopeStillHolds } from "./commitScope";
import { useChanges } from "./useChanges";

// What Commit records (commitScope.ts), shared by everything that shows it: the Changes list dims the rows outside it,
// and the composer (the commit page on a desktop, the list's own dock on a phone) records it. The pick lives here
// rather than in a component, so the list and the page can never disagree about it.

// Picked from the chips, or else undefined for the default: the session the commit was asked to be named after, git's
// own selection when something is staged, the one session whose work is all that's here, or everything.
const picked = sandboxRef<CommitScope | undefined>(() => (namedAfter.value === undefined ? undefined : { kind: `origin`, id: namedAfter.value }));

// One chip of the scope row: a choice of what to commit, with how many files it holds.
export interface ScopeChip {
    readonly key: string;
    readonly scope: CommitScope;
    readonly files: number;
    // Drawn with a divider before it: the first of git's own selections after the sessions.
    readonly divided: boolean;
}

// Hover content for a session (HoverCard.show's argument), shaped here so every chip and row raises the same card.
export interface OriginCard {
    readonly label: string;
    readonly title: string;
    readonly note?: string;
    readonly messages?: readonly { text?: string; attachments?: readonly string[] }[];
}

export const useCommitScope = () => {
    const t = useT();
    const changes = useChanges();
    const { fleet } = useAgents();
    const { conversations } = useChat();

    // A repo the daemon couldn't scan stays out of every computation, while the list still draws it as its own row.
    const scannable = computed(() => changes.repos.value.filter((repo) => repo.error === undefined));
    const legend = computed(() => summarizeOrigins(scannable.value));

    // Resolves an id via the live fleet card first (repaints on a rename instantly), then the review's own
    // `originAgents`, which survives archiving. An id-shaped fallback still draws a chip rather than reattributing the
    // file to the user.
    const agentOf = (id: string) => fleet.value.find((agent) => agent.id === id);
    const originOf = (id: string) => changes.originAgents.value[id];
    // Undefined for the id-shaped fallback: readable, but not fit to use as a commit subject.
    const originTitle = (id: string): string | undefined => agentOf(id)?.title ?? originOf(id)?.title;
    const originLabel = (id: string): string => originTitle(id) ?? t(`workspace.reviewPanel.agentId`, { id: id.slice(0, 6) });
    const originProvider = (id: string): string | undefined => agentOf(id)?.provider ?? originOf(id)?.provider;
    // Whether a session's file count is a total (session stopped) or an instalment (still running), read from the
    // fleet's own lane machine, not `status` alone: a parked-on-a-question agent has a settled status but sits in
    // Attention.
    const originMark = (id: string) => unfinishedMark(agentOf(id));
    // Read off the fleet roster's live draft report, not the review (which would cost a rescan).
    const originDraft = (id: string): LandedMessageDraft | undefined => agentOf(id)?.landedMessageDraft;
    const originDrafting = (id: string): boolean => draftRunning(originDraft(id));

    // `turns` counts completed turns, so a session already running again is on turn N+1. Stamped when the card opens,
    // not ticked: HoverCard snapshots its content at show(), so a held-open card reads stale on purpose.
    const originNote = (id: string): string | undefined => {
        const mark = originMark(id);
        const agent = agentOf(id);
        if (mark === undefined || agent === undefined) {
            return undefined;
        }
        const turn = agent.turns !== undefined && agent.turns > 0 ? `turn ${agent.turns + 1}` : undefined;
        const doing = currentAction(agent.activity);
        const since = agent.startedAt !== undefined ? formatElapsed((Date.now() - agent.startedAt) / 1000) : undefined;
        return [mark.label, turn, doing, since].filter((part) => part !== undefined && part !== ``).join(` · `);
    };

    // The session's landed-diff subject (drafted at land time), not its title: a title names the ask, the diff says
    // what actually changed. Roster first (live, pushed instantly), then the review, same lookup order as above.
    const landedOf = (id: string): LandedMessage | undefined => landedMessage(agentOf(id), originOf(id));
    const originMessage = (id: string): string | undefined => commitMessageOf(landedOf(id));

    // Includes attachments: a screenshot is often the whole of what was asked, and dropping it would misquote the
    // prompt.
    const firstPromptOf = (id: string): { text?: string; attachments?: readonly string[] } | undefined => {
        const conversation = conversations.value.find((candidate) => candidate.conversationId === id);
        const prompt = conversation?.transcript.messages.value.find((message) => message.role === `user`);
        return prompt === undefined ? undefined : { text: prompt.text, attachments: prompt.attachments };
    };
    // Two agents on one file is real but rare, and a single title can't say both, so the card lists them without a
    // prompt.
    const originCard = (ids: readonly string[]): OriginCard => {
        if (ids.length !== 1) {
            return { label: t(`workspace.reviewPanel.landedBy`), title: ids.map((id) => originLabel(id)).join(`\n`) };
        }
        const id = ids[0]!;
        const prompt = firstPromptOf(id);
        const note = originNote(id);
        return {
            label: t(`workspace.reviewPanel.landedBy`),
            title: originLabel(id),
            ...(note === undefined ? {} : { note }),
            ...(prompt === undefined ? {} : { messages: [prompt] }),
        };
    };

    // An ask that arrives while the panel is open (the board's "Commit this") picks its session the same way.
    watch(namedAfter, (id) => {
        if (id !== undefined) {
            picked.value = { kind: `origin`, id };
        }
    });
    const scope = computed<CommitScope>(
        () => picked.value ?? defaultScope({ namedAfter: namedAfter.value, staged: changes.stagedCount.value, legend: legend.value }),
    );
    // A pick with nothing left to record falls back to the default (and ends a naming ask with it); an empty,
    // still-loading review retires nothing.
    watch(
        [legend, changes.stagedCount, picked],
        () => {
            const held = picked.value;
            if (held === undefined || !changes.loaded.value || changes.count.value === 0) {
                return;
            }
            if (!scopeStillHolds(held, { staged: changes.stagedCount.value, legend: legend.value })) {
                picked.value = undefined;
                if (held.kind === `origin` && namedAfter.value === held.id) {
                    nameCommitAfter(undefined);
                }
            }
        },
        { immediate: true },
    );
    const pickScope = (next: CommitScope): void => {
        picked.value = next;
        // Naming follows the pick, and leaving a session's scope withdraws its sentence from the box.
        nameCommitAfter(next.kind === `origin` ? next.id : undefined);
    };
    // Back to the default, as a finished commit leaves it.
    const resetScope = (): void => {
        picked.value = undefined;
    };
    // One click picks a chip. Clicking the picked session (or your own edits) again lets go of it, back to whatever
    // the box would open on, or to everything when that is the same session.
    const toggleScope = (target: CommitScope): void => {
        if (!sameScope(target, scope.value)) {
            pickScope(target);
            return;
        }
        if (target.kind === `staged` || target.kind === `everything`) {
            return;
        }
        const fallback = defaultScope({ namedAfter: undefined, staged: changes.stagedCount.value, legend: legend.value });
        if (sameScope(fallback, target)) {
            pickScope({ kind: `everything` });
            return;
        }
        picked.value = undefined;
        nameCommitAfter(undefined);
    };
    const scopeOrigin = computed<string | undefined>(() => (scope.value.kind === `origin` ? scope.value.id : undefined));

    // The scope in words, for a chip's label and every sentence naming it.
    const scopeLabel = (target: CommitScope): string => {
        switch (target.kind) {
            case `staged`:
                return t(`workspace.reviewPanel.scopeStaged`);
            case `everything`:
                return t(`workspace.reviewPanel.scopeEverything`);
            case `origin`:
                return originLabel(target.id);
            case `yours`:
                return t(`workspace.savePanel.ownEdits`);
        }
    };

    // Every choice worth a chip: each session with work here, your own edits (only beside some session's, since with
    // none they are the same files as everything), git's index when it holds something, and everything. A row of one
    // is no choice, so the row is drawn only from two.
    const scopeChips = computed<readonly ScopeChip[]>(() => {
        const byOrigin: ScopeChip[] = [
            ...legend.value.agents.map((entry) => ({
                key: `origin:${entry.id}`,
                scope: { kind: `origin`, id: entry.id } as const,
                files: entry.files,
                divided: false,
            })),
            ...(legend.value.agents.length > 0 && legend.value.yours > 0
                ? [{ key: `yours`, scope: { kind: `yours` } as const, files: legend.value.yours, divided: false }]
                : []),
        ];
        const ofGit: ScopeChip[] = [
            ...(changes.stagedCount.value > 0
                ? [{ key: `staged`, scope: { kind: `staged` } as const, files: changes.stagedCount.value, divided: false }]
                : []),
            { key: `everything`, scope: { kind: `everything` }, files: changes.count.value, divided: false },
        ];
        const [first, ...rest] = ofGit;
        return [...byOrigin, { ...first!, divided: byOrigin.length > 0 }, ...rest];
    });

    // Whether a row is part of what Commit records; one outside it is drawn dimmed.
    const rowInScope = (repo: RepoChanges, side: GitDiffSide, path: string): boolean => inScope(scope.value, repo, side, path);

    // What the press records, repo by repo, resolved by the daemon from the scope rather than the rows drawn, so a
    // truncated review still commits all of it (commitScope.ts).
    const plan = computed(() => scopeCommit(scope.value, scannable.value));
    const covered = computed(() => scopeFiles(scope.value, scannable.value));

    return {
        scannable,
        legend,
        agentOf,
        originLabel,
        originProvider,
        originMark,
        originDraft,
        originDrafting,
        originMessage,
        originCard,
        scope,
        pickScope,
        resetScope,
        toggleScope,
        scopeOrigin,
        scopeLabel,
        scopeChips,
        rowInScope,
        plan,
        covered,
    };
};
