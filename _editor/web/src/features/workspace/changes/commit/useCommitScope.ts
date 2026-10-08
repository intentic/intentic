import { isScratch, type GitDiffSide, type LandedMessage, type LandedMessageDraft, type RepoChanges } from "@intentic/sandbox-contract";
import { formatElapsed } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { useAgents } from "../../../agents/fleet/useAgents";
import { currentAction, unfinishedMark } from "../../../agents/fleet/agentStatus";
import { useChat } from "../../../chat/run/useChat";
import { commitMessageOf, draftRunning, landedMessage, originsOf, summarizeOrigins } from "../changeOrigins";
import { nameCommitAfter, namedAfter } from "./commitMessage";
import { type CommitScope, commitScopeFor, inScope, namingOrigin, scopeCommit, scopeFiles } from "./commitScope";
import { truncatedTotal } from "../truncation";
import { useChanges } from "../useChanges";

// What Commit records and what to stage for it, shared by everything that shows it: the Changes list, the scope chips,
// and the composer (the commit page on a desktop, the list's own dock on a phone). Commit records the index, or
// everything when nothing is staged (commitScope.ts); a chip stages a session's files, your own, or all of them, the
// same move as a row's +, and takes them back out when they are all in already.

// One chip: a set of files to stage in one click, and how much of it the index already holds.
export interface ScopeChip {
    readonly key: string;
    // A session's id, `yours` for the files no session landed, or `all`.
    readonly kind: `origin` | `yours` | `all`;
    readonly id?: string;
    readonly files: number;
    readonly staged: number;
    // Drawn with a divider before it: All, after the sessions and your own edits.
    readonly divided: boolean;
}
export type ChipState = `on` | `mixed` | `off`;
export const chipState = (chip: ScopeChip): ChipState => (chip.staged === 0 ? `off` : chip.staged >= chip.files ? `on` : `mixed`);

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

    const scope = computed<CommitScope>(() => commitScopeFor(changes.stagedCount.value));
    // The one session this commit is wholly the work of, whose drafted sentence the box takes (commitScope.ts).
    const scopeOrigin = computed<string | undefined>(() => namingOrigin(scope.value, scannable.value));
    // The box's naming follows it, so a sentence leaves the box when the commit stops being that session's alone.
    watch(
        scopeOrigin,
        (id) => {
            if (changes.loaded.value && id !== namedAfter.value) {
                nameCommitAfter(id);
            }
        },
        { immediate: true },
    );

    // The files each chip stands for, among the rows listed: a conflict is never staged from here (git add would mark it
    // resolved), and scratch stays out, as every stage-everything leaves it out.
    const chipPaths = (repo: RepoChanges, kind: ScopeChip[`kind`], id: string | undefined): { all: Set<string>; staged: Set<string> } => {
        const all = new Set<string>();
        const staged = new Set<string>();
        const conflicted = new Set(repo.conflicted.map((change) => change.path));
        const belongs = (path: string): boolean => {
            if (conflicted.has(path) || isScratch(path, repo.scratch ?? [])) {
                return false;
            }
            const ids = originsOf(repo, path);
            return kind === `all` || (kind === `yours` ? ids.length === 0 : ids.includes(id!));
        };
        for (const change of repo.unstaged) {
            if (belongs(change.path)) {
                all.add(change.path);
            }
        }
        for (const change of repo.staged) {
            if (belongs(change.path)) {
                all.add(change.path);
                staged.add(change.path);
            }
        }
        // A path with more on the unstaged side isn't wholly in.
        for (const change of repo.unstaged) {
            staged.delete(change.path);
        }
        return { all, staged };
    };
    const chipOf = (kind: ScopeChip[`kind`], id: string | undefined, divided: boolean): ScopeChip => {
        let files = 0;
        let staged = 0;
        for (const repo of scannable.value) {
            const paths = chipPaths(repo, kind, id);
            files += paths.all.size;
            staged += paths.staged.size;
        }
        return { key: id === undefined ? kind : `${kind}:${id}`, kind, ...(id === undefined ? {} : { id }), files, staged, divided };
    };
    // A chip per session with work here, your own edits beside them (alone they are the same files as All), and All.
    // A row of one is no choice, so it is drawn only from two.
    const scopeChips = computed<readonly ScopeChip[]>(() => {
        const sessions = legend.value.agents.map((entry) => chipOf(`origin`, entry.id, false));
        const yours = sessions.length > 0 && legend.value.yours > 0 ? [chipOf(`yours`, undefined, false)] : [];
        const chips = [...sessions, ...yours].filter((chip) => chip.files > 0);
        return [...chips, chipOf(`all`, undefined, chips.length > 0)];
    });

    // One click: stage the chip's files, or take them back out when the index already holds them all. Named by scope
    // rather than path, so files past a truncated list go in too; a conflict never does.
    const toggleChip = (chip: ScopeChip): Promise<void> => {
        const into = chipState(chip) !== `on`;
        const side = into ? (`unstaged` as const) : (`staged` as const);
        const scopeOf = chip.kind === `origin` ? { origin: chip.id! } : chip.kind === `yours` ? { unlanded: true } : {};
        const groups = scannable.value
            .filter((repo) => {
                const paths = chipPaths(repo, chip.kind, chip.id);
                return into ? paths.all.size > paths.staged.size || truncatedTotal(repo) > 0 : paths.staged.size > 0;
            })
            .map((repo) => ({ repo: repo.repo, scope: { ...scopeOf, side } }));
        return changes.stageGroups(groups, into);
    };

    // The chip in words: a session's title, your own edits, or everything.
    const chipLabel = (chip: ScopeChip): string =>
        chip.kind === `origin`
            ? originLabel(chip.id!)
            : chip.kind === `yours`
              ? t(`workspace.savePanel.ownEdits`)
              : t(`workspace.reviewPanel.scopeEverything`);

    // What the press records, repo by repo (commitScope.ts).
    const plan = computed(() => scopeCommit(scope.value, scannable.value));
    const covered = computed(() => scopeFiles(scope.value, scannable.value));
    // Whether a row is part of what Commit records.
    const rowInScope = (repo: RepoChanges, side: GitDiffSide, path: string): boolean => inScope(scope.value, repo, side, path);

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
        scopeOrigin,
        scopeChips,
        toggleChip,
        chipLabel,
        rowInScope,
        plan,
        covered,
    };
};
