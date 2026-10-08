<script setup lang="ts">
import type { LandedMessageDraft, RepoTarget } from "@intentic/sandbox-contract";
import { Button, ContextMenu, formatElapsed, growTextarea, type IconName, timeAgo, type Tip, ui, useDevice } from "@intentic/ui";
import { messageOr, useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref, watch } from "vue";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { useChat } from "../../chat/run/useChat";
import { formatChord, isApplePlatform } from "../../../workbench/commands/keybindings";
import { useNotifications } from "../../../workbench/notifications/notifications";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import { useLayout } from "../../../workbench/window/useLayout";
import { useRepos } from "../explorer/useRepos";
import { repoOfPath, turnWrites } from "../files/liveWrites";
import { ahead, syncable, unpublished } from "../push/outgoingWork";
import { useOutgoing } from "../push/useOutgoing";
import { chipMessageNotice, draftReport, draftRunning, type DraftReportRow, summarizeOrigins } from "./changeOrigins";
import { boxIsYours, commitMessage, followFilledMessage, nameCommitAfter } from "./commitMessage";
import { draftLine, type DraftLine } from "./commitScope";
import { COMMIT_SCOPE, useChanges } from "./useChanges";
import { useCommitScope } from "./useCommitScope";

// What Commit records, the message that names it, and the verbs that send it: the commit page's middle on a desktop
// (`page`), and the Changes list's own dock on a phone (`dock`), where the button rides inside the message field the
// way the chat composer's send does. The scope it records is shared with the list (useCommitScope.ts); the message
// outlives both (commitMessage.ts).

const { variant } = defineProps<{ variant: `page` | `dock` }>();
const page = computed(() => variant === `page`);

const t = useT();
const changes = useChanges();
const words = useVocabulary();
const { conversations } = useChat();
const { mobile } = useDevice();
const layout = useLayout();
const { say } = useNotifications();
const { scannable, legend, originLabel, originMark, originDraft, originMessage, scope, scopeOrigin, scopeLabel, resetScope, plan, covered } =
    useCommitScope();

// A phone keyboard has no Ctrl, so the shortcut hint moves to the button label instead.
const commitPlaceholder = computed(() => (mobile.value ? t(`workspace.reviewPanel.message`) : t(`workspace.reviewPanel.messageCtrlEnter`)));

// Computed, not read at the pick: recomputes as the review updates, so a message drafted seconds after the pick still
// reaches the box without a second one.
const scopeMessage = computed<string | undefined>(() => (scopeOrigin.value === undefined ? undefined : originMessage(scopeOrigin.value)));
followFilledMessage(scopeMessage, { immediate: true });
// Read off the fleet roster's live draft report, not the review (which would cost a rescan). Distinguishes
// "nothing was written" from "one is coming", which used to be the same empty box.
const scopeDraft = computed<LandedMessageDraft | undefined>(() => (scopeOrigin.value === undefined ? undefined : originDraft(scopeOrigin.value)));
// Ticks only while the scope's draft is running, so its in-flight step's elapsed time actually moves.
const draftClock = useNow(() => draftRunning(scopeDraft.value));
// The one line under the box: how its drafted message is going, at a fixed height (commitScope.ts).
const scopeDraftLine = computed<DraftLine>(() => draftLine(scopeDraft.value, scopeMessage.value !== undefined));
// The full step list, opened from that line on demand: the models asked, and why each said no.
const draftDetailsOpen = ref(false);
const scopeDraftRows = computed<readonly DraftReportRow[]>(() => (draftDetailsOpen.value ? draftReport(scopeDraft.value, draftClock.value) : []));
watch(scopeOrigin, () => {
    draftDetailsOpen.value = false;
});
const draftSince = computed(() => {
    const line = scopeDraftLine.value;
    return line.state === `asking` && line.since !== undefined ? formatElapsed(Math.max(0, draftClock.value - line.since) / 1000) : undefined;
});
// Asks the models again, for a message that came out wrong or never came. The box keeps the old one until the new one
// replaces it, so there's never an empty box to type into by mistake.
const redrafting = ref(false);
const redraft = async (): Promise<void> => {
    const id = scopeOrigin.value;
    if (id === undefined || redrafting.value) {
        return;
    }
    redrafting.value = true;
    try {
        await sandboxRpc.agents.redraftMessage({ id });
    } catch (caught) {
        say(messageOr(caught, t(`workspace.reviewPanel.couldntRedraft`)));
    } finally {
        redrafting.value = false;
    }
};

// One glyph and colour per row status, isolated to a narrow column so the reason text stays untinted.
// A refusal mid-chain isn't an error (the fallback is working); only a draft that ends with nothing is amber.
const STEP_MARKS: Record<DraftReportRow[`status`], { icon: IconName; spin?: boolean; tone: string }> = {
    reading: { icon: `spinner`, spin: true, tone: `text-subtle` },
    asking: { icon: `spinner`, spin: true, tone: `text-link` },
    answered: { icon: `check`, tone: `text-success` },
    refused: { icon: `times`, tone: `text-subtle` },
    skipped: { icon: `forward`, tone: `text-subtle` },
    failed: { icon: `exclamation-triangle`, tone: `text-warning` },
};

// States why the box didn't fill: still writing, none written, your own edits have none, or the box is the user's own
// text. Placeholder while empty; the draft line says the rest once there's text.
const chipNotice = computed<string | undefined>(() =>
    chipMessageNotice({
        label: scope.value.kind === `origin` || scope.value.kind === `yours` ? scopeLabel(scope.value) : undefined,
        yours: scope.value.kind === `yours`,
        message: scopeMessage.value,
        draft: scopeDraft.value,
        boxIsYours: boxIsYours.value,
    }),
);

// The message lives outside component state (commitMessage.ts), since this panel is mounted behind a v-if
// and must survive a trip to look at the files it describes. What it records is the scope's, resolved by the daemon
// from a scope rather than the rows drawn, so a truncated review still commits all of it (commitScope.ts).
const commitGroups = computed(() => plan.value.groups);
const commitTarget = computed(() => commitGroups.value.map((group) => group.repo));
// Any repo's unresolved conflict blocks the whole button: a commit spans repos sharing one message, and git would
// refuse mid-batch.
const blockedByConflicts = computed(() => scannable.value.some((repo) => repo.conflicted.length > 0));
// Reads the daemon's own "committing" flag (unioned with this tab's in-flight batch), narrowed to the
// repos this box would actually commit — a run in a repo the scope excludes isn't this button's concern.
const committingNow = computed(() => commitTarget.value.filter((repo) => changes.committing.value.includes(repo)));
const commitRunning = computed(() => committingNow.value.length > 0);
const commitReady = computed(
    () =>
        commitTarget.value.length > 0 &&
        commitMessage.value.trim().length > 0 &&
        !blockedByConflicts.value &&
        !changes.actionBusy.value &&
        !commitRunning.value,
);

// The scope line's tail: how many files, and what the press does to the index on the way.
const scopeDetail = computed<string>(() => {
    const { files, complete } = covered.value;
    const count = complete
        ? t(`workspace.reviewPanel.fileCount`, { count: files }, files)
        : t(`workspace.reviewPanel.fileCountAtLeast`, { count: files }, files);
    const how =
        scope.value.kind === `staged`
            ? undefined
            : plan.value.only && changes.stagedCount.value > 0
              ? t(`workspace.reviewPanel.leavesStagedAlone`)
              : t(`workspace.reviewPanel.stagesThemForYou`);
    // The page's button already says how many files; beside it only the index note is news.
    if (page.value && files > 0) {
        return how ?? ``;
    }
    return how === undefined ? count : `${count} · ${how}`;
});

// The commit button's hover: what the press will record, and the chord that presses it from the box. Nothing while it
// runs, since the readout beside it already names the repos being committed.
const COMMIT_KEYS = formatChord(`Mod+Enter`, isApplePlatform());
const conflictedCount = computed(() => scannable.value.reduce((total, repo) => total + repo.conflicted.length, 0));
const commitTip = computed((): Tip | undefined => {
    const keys = mobile.value ? undefined : COMMIT_KEYS;
    if (commitRunning.value) {
        return undefined;
    }
    if (blockedByConflicts.value) {
        return {
            title: t(`workspace.reviewPanel.conflicts`),
            tone: `danger`,
            rows: [{ label: t(`shared.files`), value: conflictedCount.value }],
            note: t(`workspace.reviewPanel.stageToResolve`),
        };
    }
    return {
        title: t(`workspace.reviewPanel.commit`),
        keys,
        rows: [{ label: scopeLabel(scope.value), value: covered.value.complete ? covered.value.files : `` }],
        note: plan.value.only
            ? t(`workspace.reviewPanel.nothingElseGoesIn`)
            : commitGroups.value.length > 1
              ? t(`workspace.reviewPanel.onePerRepo`)
              : undefined,
    };
});

// Sessions this commit would record, and which are still running — scoped exactly like the button. A
// warning, not a gate: committing part of an unfinished agent's work is ordinary, and Undo takes it back.
const commitOrigins = computed(() => {
    const current = scope.value;
    if (current.kind === `origin`) {
        return legend.value.agents.filter((entry) => entry.id === current.id);
    }
    if (current.kind === `staged`) {
        return summarizeOrigins(scannable.value, [`staged`]).agents;
    }
    return current.kind === `yours` ? [] : legend.value.agents;
});
const unfinished = computed(() => commitOrigins.value.filter((entry) => originMark(entry.id) !== undefined));

// Only matters for a stage-first commit, which reads the live worktree — a plain commit already froze its
// content at stage time. Only main-tree turns count: an isolated turn reaches this tree through land, which the daemon
// already serializes against every git write here.
const repos = useRepos();
const writingRepos = computed<ReadonlySet<string>>(
    () =>
        new Set(
            conversations.value
                .filter((conversation) => !conversation.isolated.value && conversation.turn.streaming.value)
                .flatMap((conversation) =>
                    [...turnWrites(conversation.conversationId, conversation.turn.turnStartedAt.value)].map((path) =>
                        repoOfPath(path, repos.repoDirs.value),
                    ),
                ),
        ),
);
// Named in the warning; everything else is committable right now, which is why this is scoped per repo, not per
// workspace.
const atRisk = computed(() => (plan.value.stage ? commitTarget.value.filter((repo) => writingRepos.value.has(repo)) : []));
const unaffected = computed(() => commitGroups.value.filter((group) => !writingRepos.value.has(group.repo)));

// What the press does: a new commit, or the last one rewritten; and whether the commits then go out.
type CommitVerb = `commit` | `commitPush` | `amend`;
const runCommit = async (target: readonly RepoTarget[], verb: CommitVerb = `commit`): Promise<void> => {
    const amend = verb === `amend`;
    const recorded = await changes.commitRepos(
        target,
        commitMessage.value,
        { stage: plan.value.stage, only: plan.value.only, amend },
        covered.value.complete ? covered.value.files : undefined,
    );
    // Keeps the message on failure — it's the one thing here the user typed by hand.
    if (!changes.failures.value.has(COMMIT_SCOPE)) {
        commitMessage.value = ``;
        // Ends the naming ask with the commit that fulfilled it, or a message still being drafted would fill the NEXT
        // commit's box.
        nameCommitAfter(undefined);
        resetScope();
    }
    if (verb === `commitPush` && recorded.length > 0) {
        outgoingState.doSync(recorded.map((commit) => commit.repo));
    }
};
// Ctrl+Enter reaches this too, so a silently-ignored chord just gets retried harder; this names which of the
// reasons applied instead. An amend may go without a message: it keeps the last commit's own.
const blockerFor = (amend: boolean): string | undefined => {
    if (blockedByConflicts.value) {
        return t(`workspace.reviewPanel.blockedByConflicts`);
    }
    // Checked ahead of "nothing to commit": mid-commit the rows are still listed, so this is the honest reason, not a
    // count about to change.
    if (commitRunning.value) {
        return t(`workspace.reviewPanel.stillCommitting`, { repos: committingNow.value.join(`, `) });
    }
    if (commitTarget.value.length === 0) {
        return t(`workspace.reviewPanel.nothingToCommit`);
    }
    if (!amend && commitMessage.value.trim().length === 0) {
        return t(`workspace.reviewPanel.writeMessageFirst`);
    }
    if (amend && !amendable.value) {
        return t(`workspace.reviewPanel.lastCommitPushed`);
    }
    return changes.actionBusy.value ? t(`workspace.reviewPanel.anotherGitAction`) : undefined;
};
const commitBlocker = computed(() => blockerFor(false));
// Shown after a rejected Ctrl+Enter; cleared on the next edit, so it never outlives what it described.
const blockerNotice = ref<string | undefined>(undefined);
watch([commitMessage, commitBlocker], () => {
    blockerNotice.value = undefined;
});
const doCommit = async (verb: CommitVerb = `commit`): Promise<void> => {
    const blocker = blockerFor(verb === `amend`);
    if (blocker !== undefined) {
        blockerNotice.value = blocker;
        return;
    }
    await runCommit(commitGroups.value, verb);
};

// An amend only rewrites a commit no remote holds yet: every repo it reaches is ahead of its upstream, or has none.
// The daemon checks again, against every remote branch, so this only keeps the menu honest.
const amendable = computed(() =>
    commitGroups.value.every((group) => {
        const repo = scannable.value.find((candidate) => candidate.repo === group.repo);
        return repo !== undefined && (!syncable(repo) || unpublished(repo) || ahead(repo) > 0);
    }),
);

// The split button's other verbs: commit and send it, or fold this into the last commit.
const commitMenu = ref<{ show: (event: Event) => void }>();
const commitMenuItems = computed<MenuItem[]>(() => [
    {
        label: t(`workspace.reviewPanel.commit`),
        icon: `check`,
        shortcut: mobile.value ? undefined : COMMIT_KEYS,
        command: () => void doCommit(`commit`),
    },
    {
        label: t(`workspace.reviewPanel.commitAndPush`, { verb: words.value.push }),
        icon: `arrow-up`,
        disabled: !commitReady.value,
        command: () => void doCommit(`commitPush`),
    },
    { separator: true },
    {
        label: t(`workspace.reviewPanel.amendLast`),
        icon: `pencil`,
        hint: amendable.value
            ? commitMessage.value.trim().length === 0
                ? t(`workspace.reviewPanel.amendKeepsMessage`)
                : t(`workspace.reviewPanel.amendReplacesMessage`)
            : t(`workspace.reviewPanel.lastCommitPushed`),
        disabled: blockerFor(true) !== undefined,
        command: () => void doCommit(`amend`),
    },
]);

// The receipt of the last commit this tab recorded, with the way back: a soft reset, so its files return staged and
// its message returns to the box. Offered only while no remote holds it, since walking a pushed commit back would
// need a force push to follow.
// A repo the scan no longer lists is clean with nothing to sync: still undoable when it had no remote, already held by
// its remote when it did.
const receipt = computed(() => changes.lastCommit.value);
const receiptUndoable = computed(() => {
    const commits = receipt.value?.commits ?? [];
    return (
        commits.length > 0 &&
        commits.every((commit) => {
            const repo = scannable.value.find((entry) => entry.repo === commit.repo);
            return repo === undefined ? !commit.remote : !syncable(repo) || unpublished(repo) || ahead(repo) > 0;
        })
    );
});
const receiptLine = computed<string | undefined>(() => {
    const held = receipt.value;
    if (held === undefined) {
        return undefined;
    }
    const sha = held.commits.length === 1 ? held.commits[0]!.sha.slice(0, 7) : undefined;
    const verb = held.amend ? t(`workspace.reviewPanel.amendedAs`, { sha: sha ?? `` }) : t(`workspace.reviewPanel.committedAs`, { sha: sha ?? `` });
    return sha === undefined ? t(`workspace.reviewPanel.committedInRepos`, { count: held.commits.length }, held.commits.length) : verb;
});
const undoReceipt = async (): Promise<void> => {
    const held = receipt.value;
    if (held === undefined) {
        return;
    }
    await changes.undoCommit(held);
    // The words come back too, unless the box already holds new ones.
    if (!changes.failures.value.has(COMMIT_SCOPE) && commitMessage.value.trim().length === 0 && !held.amend) {
        commitMessage.value = held.message;
    }
};

// A textarea, not an input, since a message can carry a release-note trailer as a body. Measured via
// `scrollHeight`, not counted newlines — a single wrapped line is still one line to `split`.
// Eight lines at this box's font/padding in the dock, matching the chat composer's own ceiling (ChatPane); the page has
// the room for a body to be read whole.
const maxCommitHeight = computed(() => (page.value ? 360 : 142));
const commitBox = ref<HTMLTextAreaElement | null>(null);
// This box has its own border (the composer's doesn't), so growTextarea reads it off the element rather than a
// constant.
const growCommitBox = (): void => {
    growTextarea(commitBox.value, maxCommitHeight.value);
};
// Watched, not `@input`: most of what fills this box isn't typing (a scope's fill, a clear, a sandbox switch).
// Sidebar width and `chipNotice` are in the list too, since a re-wrap or a longer placeholder both change the needed
// height.
watch([commitBox, commitMessage, chipNotice, layout.sidebarWidth, maxCommitHeight], growCommitBox, { flush: `post` });

// The remote half of the dock (push/useOutgoing.ts): the sync every repo needs, its run, and a closed card's verdict.
const outgoingState = useOutgoing();
const { pushFlow, outgoing, syncMeta, syncLabel, syncSummary, syncTip, stageLine, stageHint, stageTip, heldTip } = outgoingState;
// Commit keeps the primary slot while there's anything to record, so the two buttons are never both full-weight.
const syncSeverity = computed<"secondary" | undefined>(() => (changes.count.value > 0 ? `secondary` : undefined));

// What the button says: the verb, and on the page how much it records.
const commitLabel = computed(() => {
    if (commitRunning.value) {
        return t(`workspace.reviewPanel.committing`);
    }
    const { files, complete } = covered.value;
    if (!page.value || files === 0) {
        return t(`workspace.reviewPanel.commit`);
    }
    return complete
        ? t(`workspace.reviewPanel.commitFiles`, { count: files }, files)
        : t(`workspace.reviewPanel.commitFilesAtLeast`, { count: files }, files);
});
// The line beside the button: the reason it won't go when there is one, else what the press does to the index.
const actionNote = computed<{ readonly text: string; readonly tone: string } | undefined>(() => {
    if (blockedByConflicts.value) {
        return { text: t(`workspace.reviewPanel.resolveConflictsFirst`), tone: `text-danger` };
    }
    if (commitRunning.value) {
        return { text: t(`workspace.reviewPanel.committingNow`, { repos: committingNow.value.join(`, `) }), tone: `text-subtle` };
    }
    if (blockerNotice.value !== undefined) {
        return { text: blockerNotice.value, tone: `text-warning` };
    }
    return changes.count.value > 0 && scopeDetail.value !== `` ? { text: scopeDetail.value, tone: `text-subtle` } : undefined;
});
// The dock's status line: the last commit's receipt, else what the remote is owed; the remote's button sits at its
// end either way.
const showSync = computed(() => outgoing.value !== `flow` && syncMeta.value !== undefined);
const showDock = computed(() => changes.count.value > 0 || outgoing.value !== undefined || receiptLine.value !== undefined);

// A bordered block, not loose coloured text: an error needs a container or it reads as gibberish, not a failure.
const NOTICE = `flex items-start gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5`;
// The same shape one severity down: a heads-up about something that hasn't gone wrong yet, on an action still
// available.
const WARNING = `flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5`;
const failureIn = (key: string) => changes.failures.value.get(key);
</script>

<template>
    <div
        v-if="page || showDock"
        class="flex min-w-0 flex-col"
        :class="page ? `gap-2.5` : `shrink-0 gap-1.5 border-t border-line-subtle p-2`"
        :data-commit-dock="page ? undefined : ``"
        :data-commit-composer="variant"
    >
        <!-- The dock's status line: the last commit and its way back, else what the remote is owed, and the remote's
             verb at its end. The page draws the same receipt under its own buttons instead. -->
        <div v-if="!page && (receiptLine !== undefined || showSync)" class="flex min-w-0 items-center gap-1.5 text-2xs">
            <template v-if="receiptLine !== undefined">
                <Icon name="check" class="shrink-0 text-success" />
                <span class="min-w-0 flex-1 truncate text-muted" v-tooltip.top="receipt?.message" data-commit-receipt>{{ receiptLine }}</span>
                <button
                    v-if="receiptUndoable"
                    type="button"
                    :class="ui.textAction(`shrink-0 text-link hover:underline`)"
                    :disabled="changes.actionBusy.value"
                    v-tooltip.top="{ title: t(`workspace.reviewPanel.undoCommit`), note: t(`workspace.reviewPanel.undoCommitNote`) }"
                    @click="undoReceipt"
                    data-commit-undo
                >
                    {{ t(`workspace.reviewPanel.undo`) }}
                </button>
                <button
                    type="button"
                    class="shrink-0 rounded p-0.5 text-subtle transition-colors hover:text-content"
                    @click="changes.dismissReceipt"
                    :aria-label="t(`ui.action.dismiss`)"
                >
                    <Icon name="times" class="text-3xs" />
                </button>
            </template>
            <span v-else class="min-w-0 flex-1 truncate text-subtle">{{ syncSummary }}</span>
            <Button
                v-if="showSync"
                size="small"
                :severity="syncSeverity"
                class="shrink-0 whitespace-nowrap"
                :disabled="changes.actionBusy.value"
                v-tooltip.top="syncTip"
                @click="outgoingState.doSync()"
                data-sync
            >
                <Icon :name="syncMeta!.icon" />{{ syncLabel }}
            </Button>
        </div>

        <template v-if="changes.count.value > 0">
            <!-- The box, its draft line and (in the dock) the button are one field, the way the chat composer holds its
                 send: the line keeps one height through every state, so nothing under it moves when a message lands. -->
            <div class="ui-field-box flex min-w-0 flex-col gap-0 !p-0 focus-within:border-primary-500" :class="page ? `` : `ui-field-sm`">
                <textarea
                    ref="commitBox"
                    v-model="commitMessage"
                    :rows="page ? 4 : 1"
                    :placeholder="chipNotice ?? commitPlaceholder"
                    class="block w-full min-w-0 resize-none overflow-y-auto border-0 bg-transparent outline-none"
                    :class="page ? `max-h-[360px] px-3 py-2 text-sm leading-relaxed` : `max-h-[142px] px-2 py-1.5 leading-snug`"
                    @keydown.ctrl.enter.exact="doCommit()"
                    @keydown.meta.enter.exact="doCommit()"
                    data-commit-message
                ></textarea>
                <div
                    v-if="!page || scopeOrigin !== undefined"
                    class="flex min-w-0 items-center gap-1.5 border-t border-dashed border-line-subtle text-2xs"
                    :class="page ? `h-7 px-3` : `min-h-7 py-0.5 pr-0.5 pl-2`"
                    data-draft-line
                >
                    <template v-if="scopeOrigin !== undefined">
                        <template v-if="scopeDraftLine.state === `reading` || scopeDraftLine.state === `asking`">
                            <Icon name="spinner" spin class="shrink-0 text-3xs text-link" />
                            <span class="min-w-0 truncate text-muted">
                                {{ t(`workspace.reviewPanel.writingMessage`) }}
                                <span v-if="scopeDraftLine.state === `asking`" class="text-subtle"
                                    >{{ scopeDraftLine.model }}<template v-if="draftSince"> · {{ draftSince }}</template></span
                                >
                            </span>
                        </template>
                        <template v-else-if="scopeDraftLine.state === `written`">
                            <Icon name="check" class="shrink-0 text-3xs text-success" />
                            <span class="min-w-0 truncate text-subtle">{{
                                scopeDraftLine.model === undefined
                                    ? t(`workspace.reviewPanel.draftedMessage`)
                                    : t(`workspace.reviewPanel.draftedBy`, { model: scopeDraftLine.model })
                            }}</span>
                        </template>
                        <template v-else-if="scopeDraftLine.state === `failed`">
                            <Icon name="exclamation-triangle" class="shrink-0 text-3xs text-warning" />
                            <span class="min-w-0 truncate text-warning">{{ t(`workspace.reviewPanel.noDraftWritten`) }}</span>
                        </template>
                        <span v-else class="min-w-0 truncate text-subtle">{{ t(`workspace.reviewPanel.noDraftYet`) }}</span>
                        <!-- The chain behind it, on demand: which models were asked and why each said no. -->
                        <button
                            v-if="(scopeDraft?.steps.length ?? 0) > 0 && (`refused` in scopeDraftLine ? scopeDraftLine.refused > 0 : true)"
                            type="button"
                            :class="ui.textAction(`shrink-0 gap-0.5 text-subtle hover:text-content`)"
                            :aria-expanded="draftDetailsOpen"
                            @click="draftDetailsOpen = !draftDetailsOpen"
                        >
                            {{
                                `refused` in scopeDraftLine && scopeDraftLine.refused > 0
                                    ? t(`workspace.reviewPanel.failedCount`, { count: scopeDraftLine.refused }, scopeDraftLine.refused)
                                    : t(`workspace.reviewPanel.draftDetails`)
                            }}
                            <Icon :name="draftDetailsOpen ? `chevron-up` : `chevron-down`" class="text-[0.55rem]" />
                        </button>
                        <button
                            v-if="scopeDraftLine.state !== `reading` && scopeDraftLine.state !== `asking`"
                            type="button"
                            :class="ui.textAction(`shrink-0 gap-0.5 text-link hover:underline`)"
                            :disabled="redrafting"
                            v-tooltip.top="t(`workspace.reviewPanel.redraftTip`)"
                            :aria-label="t(`workspace.reviewPanel.redraft`)"
                            @click="redraft"
                            data-redraft
                        >
                            <Icon name="refresh" :spin="redrafting" class="text-3xs" /><span v-if="page">{{
                                t(`workspace.reviewPanel.redraft`)
                            }}</span>
                        </button>
                    </template>
                    <!-- No session to draft for: the dock spends the line on what the press does instead. -->
                    <span
                        v-else-if="!page && actionNote"
                        class="min-w-0 truncate"
                        :class="actionNote.tone"
                        v-tooltip.top.overflow="actionNote.text"
                        >{{ actionNote.text }}</span
                    >
                    <span class="flex-1"></span>
                    <!-- The dock's Commit, inside the field like the chat composer's send. -->
                    <span v-if="!page" class="inline-flex shrink-0" data-commit-split>
                        <Button
                            size="small"
                            severity="success"
                            class="!h-6 !min-h-0 max-md:!h-8 !rounded-r-none !px-2 whitespace-nowrap"
                            :disabled="!commitReady"
                            @click="doCommit()"
                            v-tooltip.top="commitTip"
                            data-commit
                        >
                            <Icon :name="commitRunning ? `spinner` : `check`" :spin="commitRunning" />{{ commitLabel }}
                        </Button>
                        <Button
                            size="small"
                            severity="success"
                            class="!h-6 !min-h-0 max-md:!h-8 !rounded-l-none !border-l !border-l-black/20 !px-1"
                            :disabled="commitRunning || changes.actionBusy.value"
                            :aria-label="t(`workspace.reviewPanel.moreCommitActions`)"
                            aria-haspopup="menu"
                            @click="commitMenu?.show($event)"
                            data-commit-more
                        >
                            <Icon name="chevron-down" class="text-2xs" />
                        </Button>
                    </span>
                </div>
            </div>
            <!-- In the dock with a session in scope, the draft line took the field's footer, so the reason and the
                 index note move under it, only when there's a reason to give. -->
            <p
                v-if="!page && scopeOrigin !== undefined && actionNote !== undefined && actionNote.tone !== `text-subtle`"
                class="truncate text-2xs"
                :class="actionNote.tone"
            >
                {{ actionNote.text }}
            </p>
            <!-- The steps, opened from the line above; laid over nothing, pushed only by an explicit click. -->
            <div v-if="scopeDraftRows.length > 0" class="flex flex-col gap-px rounded-md bg-overlay/60 px-1.5 py-1">
                <div v-for="row in scopeDraftRows" :key="row.key" class="flex min-w-0 items-center gap-1.5 leading-snug" v-tooltip.right="row.tip">
                    <Icon
                        :name="STEP_MARKS[row.status].icon"
                        :spin="STEP_MARKS[row.status].spin"
                        class="shrink-0 text-3xs"
                        :class="STEP_MARKS[row.status].tone"
                    />
                    <span
                        v-if="row.model !== undefined"
                        class="max-w-28 shrink-0 truncate text-2xs"
                        :class="row.status === `refused` || row.status === `skipped` ? `text-muted` : `text-content`"
                    >
                        {{ row.model }}
                    </span>
                    <span class="min-w-0 flex-1 truncate text-2xs" :class="row.status === `failed` ? `text-warning` : `text-subtle`">
                        {{ row.detail }}
                    </span>
                    <span class="w-7 shrink-0 text-right text-2xs tabular-nums text-subtle">{{ row.elapsed }}</span>
                </div>
            </div>

            <!-- The page's action row: Commit with its other verbs, the remote's verb, and what the press does. -->
            <div v-if="page" class="flex min-w-0 flex-wrap items-center gap-2">
                <span class="inline-flex shrink-0" data-commit-split>
                    <Button
                        severity="success"
                        class="!rounded-r-none whitespace-nowrap"
                        :disabled="!commitReady"
                        @click="doCommit()"
                        v-tooltip.top="commitTip"
                        data-commit
                    >
                        <Icon :name="commitRunning ? `spinner` : `check`" :spin="commitRunning" />{{ commitLabel }}
                    </Button>
                    <Button
                        severity="success"
                        class="!rounded-l-none !border-l !border-l-black/20 !px-2"
                        :disabled="commitRunning || changes.actionBusy.value"
                        :aria-label="t(`workspace.reviewPanel.moreCommitActions`)"
                        aria-haspopup="menu"
                        @click="commitMenu?.show($event)"
                        data-commit-more
                    >
                        <Icon name="chevron-down" class="text-xs" />
                    </Button>
                </span>
                <Button
                    v-if="showSync"
                    severity="secondary"
                    class="shrink-0 whitespace-nowrap"
                    :disabled="changes.actionBusy.value"
                    v-tooltip.top="syncTip"
                    @click="outgoingState.doSync()"
                    data-sync
                >
                    <Icon :name="syncMeta!.icon" />{{ syncLabel }}
                </Button>
                <span v-if="actionNote" class="min-w-0 flex-1 truncate text-xs" :class="actionNote.tone" v-tooltip.top.overflow="actionNote.text">{{
                    actionNote.text
                }}</span>
            </div>

            <!-- A warning, not a gate: the commit is the user's to make, and Undo takes it back. -->
            <div v-if="atRisk.length > 0" :class="WARNING">
                <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-warning" />
                <div class="min-w-0 flex-1">
                    <p class="break-words text-2xs text-warning">
                        {{
                            t(
                                `workspace.reviewPanel.agentEditing`,
                                { paths: atRisk.join(`, `), action: t(`workspace.reviewPanel.commit`) },
                                atRisk.length,
                            )
                        }}
                    </p>
                    <Button
                        v-if="unaffected.length > 0"
                        size="small"
                        severity="secondary"
                        class="mt-1 whitespace-nowrap"
                        :disabled="!commitReady"
                        @click="() => runCommit(unaffected)"
                        v-tooltip.right="t(`workspace.reviewPanel.commitsRepos`, { repos: unaffected.map((group) => group.repo).join(`, `) })"
                    >
                        <Icon name="check" class="mr-1 text-2xs" />{{ t(`workspace.reviewPanel.commit`) }}
                        {{ unaffected.length === 1 ? unaffected[0]!.repo : t(`workspace.reviewPanel.otherRepos`, { count: unaffected.length }) }}
                    </Button>
                </div>
            </div>
            <div v-if="unfinished.length > 0" :class="WARNING">
                <Icon name="wave-pulse" class="mt-0.5 shrink-0 text-2xs text-warning" />
                <p class="min-w-0 flex-1 break-words text-2xs text-warning">
                    {{
                        t(
                            `workspace.reviewPanel.unfinishedOrigins`,
                            {
                                origins: unfinished.map((entry) => originLabel(entry.id)).join(`, `),
                                files: t(
                                    `workspace.reviewPanel.fileWord`,
                                    {},
                                    unfinished.reduce((total, entry) => total + entry.files, 0),
                                ),
                            },
                            unfinished.length,
                        )
                    }}
                </p>
            </div>
            <!-- A commit spans every repo it reaches, so its failure belongs here, message still in the box. -->
            <div v-if="failureIn(COMMIT_SCOPE)" :class="NOTICE">
                <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-danger" />
                <div class="min-w-0 flex-1">
                    <p class="text-2xs font-medium text-danger">{{ failureIn(COMMIT_SCOPE)!.action }}</p>
                    <p class="line-clamp-4 break-words text-2xs text-muted" v-tooltip.top.overflow="failureIn(COMMIT_SCOPE)!.detail">
                        {{ failureIn(COMMIT_SCOPE)!.detail }}
                    </p>
                </div>
                <button
                    type="button"
                    class="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-content"
                    @click="changes.dismissFailure(COMMIT_SCOPE)"
                    v-tooltip.right="t(`ui.action.dismiss`)"
                    :aria-label="t(`workspace.reviewPanel.dismissCommitError`)"
                >
                    <Icon name="times" class="text-2xs" />
                </button>
            </div>
        </template>

        <!-- The page with nothing left to record still offers the remote's verb. -->
        <div v-else-if="page && showSync" class="flex min-w-0 items-center gap-2">
            <Button
                severity="secondary"
                class="shrink-0 whitespace-nowrap"
                :disabled="changes.actionBusy.value"
                v-tooltip.top="syncTip"
                @click="outgoingState.doSync()"
                data-sync
            >
                <Icon :name="syncMeta!.icon" />{{ syncLabel }}
            </Button>
            <span v-if="syncSummary" class="min-w-0 flex-1 truncate text-xs text-subtle">{{ syncSummary }}</span>
        </div>

        <!-- The page's receipt, under the buttons that made it. -->
        <div v-if="page && receiptLine !== undefined" class="flex min-w-0 items-center gap-1.5 text-xs" data-commit-receipt>
            <Icon name="check" class="shrink-0 text-success" />
            <span class="min-w-0 truncate text-muted" v-tooltip.top="receipt?.message">{{ receiptLine }}</span>
            <button
                v-if="receiptUndoable"
                type="button"
                :class="ui.textAction(`shrink-0 text-link hover:underline`)"
                :disabled="changes.actionBusy.value"
                v-tooltip.top="{ title: t(`workspace.reviewPanel.undoCommit`), note: t(`workspace.reviewPanel.undoCommitNote`) }"
                @click="undoReceipt"
                data-commit-undo
            >
                {{ t(`workspace.reviewPanel.undo`) }}
            </button>
            <button
                type="button"
                class="shrink-0 rounded p-0.5 text-subtle transition-colors hover:text-content"
                @click="changes.dismissReceipt"
                :aria-label="t(`ui.action.dismiss`)"
            >
                <Icon name="times" class="text-3xs" />
            </button>
        </div>

        <!-- A push's run and a closed card's verdict, below everything they follow from. -->
        <div v-if="outgoing === `flow`" class="flex min-w-0 items-center gap-1.5" v-tooltip.right="!mobile ? stageTip : undefined">
            <Icon
                :name="pushFlow.running.value ? `spinner` : `check-circle`"
                :spin="pushFlow.running.value"
                class="shrink-0 text-2xs"
                :class="pushFlow.running.value ? `text-link` : `text-success`"
            />
            <span class="flex min-w-0 flex-1 flex-col">
                <span class="truncate whitespace-nowrap text-2xs text-muted">{{ stageLine }}</span>
                <span v-if="mobile && stageHint" class="truncate whitespace-nowrap font-mono text-3xs text-subtle">{{ stageHint }}</span>
            </span>
            <button
                v-if="pushFlow.running.value && pushFlow.terminal.value !== undefined"
                type="button"
                :class="[ui.iconButton(`disabled:opacity-40`), 'max-md:h-8 max-md:w-8']"
                @click="pushFlow.showTerminal"
                v-tooltip.top="t(`workspace.reviewPanel.watchRun`)"
                :aria-label="t(`workspace.reviewPanel.watchRun`)"
            >
                <Icon name="terminal" class="text-2xs" />
            </button>
        </div>
        <button
            v-else-if="outgoing === `held`"
            type="button"
            :class="ui.textAction(`m-0 min-w-0 gap-2.5 rounded-md p-1 hover:bg-overlay`)"
            :aria-label="outgoingState.heldLine.value"
            v-tooltip.right="heldTip"
            @click="pushFlow.reopen"
        >
            <span class="flex size-7 shrink-0 items-center justify-center rounded-md bg-warning/10 text-warning" aria-hidden="true">
                <Icon name="exclamation-circle" class="text-base" />
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-1">
                <span class="text-xs leading-snug font-medium text-content">{{ pushFlow.held.value?.question.title }}</span>
                <span class="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-2xs leading-snug text-muted">
                    <span v-if="pushFlow.held.value" class="whitespace-nowrap">{{
                        timeAgo(pushFlow.held.value.at, { now: outgoingState.now.value })
                    }}</span>
                    <span v-if="pushFlow.heldStale.value">{{ t(`workspace.reviewPanel.filesChangedSince`) }}</span>
                </span>
            </span>
        </button>

        <ContextMenu ref="commitMenu" :model="commitMenuItems" :min-width="14" />
    </div>
</template>
