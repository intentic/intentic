<script setup lang="ts">
import type { ChangeStatus, IconName } from "@intentic/ui";
import { Button, Modal, Notice, ui } from "@intentic/ui";
import { useWorkspaceTabs } from "../tabs/useWorkspaceTabs";
import { plural } from "@intentic/base/format";
import type { DiffPayload } from "@intentic/extension-api";
import type { GitChange, GitDiffSide, LandedMessage, RepoChanges, RepoTarget } from "@intentic/api-contract";
import { computed, ref } from "vue";
import { useVocabulary } from "../../../core-views/vocabulary";
import { useAgents } from "../../agents/fleet/useAgents";
import { ahead, behind, syncable, unpublished } from "../push/outgoingWork";
import { usePushFlow } from "../push/usePushFlow";
import { draftRunning, landedMessage, originsOf, YOURS } from "./changeOrigins";
import { diffRawUrls } from "./diffRaw";
import { savedMessage, soleOrigin } from "./savedMessage";
import { truncatedTotal } from "./truncation";
import { COMMIT_SCOPE, useChanges } from "./useChanges";
import type { OpenMode } from "../tabs/workspaceTabs";
import { useT } from "@intentic/ui/i18n";

// The maker's half of the Changes sidebar, over the same read the developer's ReviewPanel uses. Everything git asks a
// developer to decide is decided here instead: there is no index (a save records the whole tree), no message to write
// (savedMessage.ts picks one), and no per-repo remote dashboard. What is left is the two questions a maker actually
// has — what changed, and do I keep it — plus the diff behind every row.

const t = useT();

const changes = useChanges();
const words = useVocabulary();
const pushFlow = usePushFlow();
const { fleet } = useAgents();

const emit = defineEmits<{ "open-diff": [payload: DiffPayload, mode: OpenMode] }>();
// The body lands in the tabs store directly, not through the host: on a phone the host swaps this panel out for the
// viewer the moment the diff opens, and an emit from an unmounted panel reaches nobody.
const { fillDiff } = useWorkspaceTabs();

// Repos git could read; the rest are listed with their reason and no actions, as in the developer's panel.
const scannable = computed(() => changes.repos.value.filter((repo) => repo.error === undefined));
const unscannable = computed(() => changes.repos.value.filter((repo) => repo.error !== undefined));

// Git's one-letter status is a developer's alphabet; a maker gets the word and a glyph for it.
const STATUS_MARK: Record<ChangeStatus, { readonly icon: IconName; readonly word: string; readonly tone: string }> = {
    added: { icon: `plus`, word: `new`, tone: `text-success` },
    modified: { icon: `pencil`, word: `changed`, tone: `text-warning` },
    deleted: { icon: `eraser`, word: `removed`, tone: `text-danger` },
    renamed: { icon: `arrow-right`, word: `renamed`, tone: `text-muted` },
    "type-changed": { icon: `repeat`, word: `changed`, tone: `text-muted` },
    conflicted: { icon: `exclamation-triangle`, word: `clashes with an edit of yours`, tone: `text-danger` },
};

interface ChangedFile {
    readonly key: string;
    readonly repo: string;
    readonly path: string;
    // What the row reads: bare inside the workspace's own repository, prefixed by project otherwise.
    readonly label: string;
    readonly status: ChangeStatus;
    // Which half of git's split the diff is read from; see `SIDE_ORDER`.
    readonly side: GitDiffSide;
    // A rename's old path. Undoing one means undoing both legs, or the file stays deleted where it was.
    readonly from?: string;
}

// A file can sit on two sides at once with different content. Nothing a maker does stages, so this only decides a
// corner case; the working tree wins, being the half they last changed.
const SIDE_ORDER: readonly GitDiffSide[] = [`conflicted`, `unstaged`, `staged`];

const fileRows = (repo: RepoChanges): readonly ChangedFile[] => {
    const seen = new Map<string, ChangedFile>();
    for (const side of SIDE_ORDER) {
        for (const change of repo[side] as readonly GitChange[]) {
            if (seen.has(change.path)) {
                continue;
            }
            seen.set(change.path, {
                key: JSON.stringify([repo.repo, change.path]),
                repo: repo.repo,
                path: change.path,
                label: repo.repo === `root` ? change.path : `${repo.repo}/${change.path}`,
                status: change.status,
                side,
                ...(change.from === undefined ? {} : { from: change.from }),
            });
        }
    }
    return [...seen.values()];
};

/** One heading's worth of rows: an assistant's landing, or the owner's own edits. */
interface OriginGroup {
    readonly id: string;
    readonly title: string;
    readonly files: readonly ChangedFile[];
}

const titleOf = (id: string): string => {
    const named = fleet.value.find((agent) => agent.id === id)?.title ?? changes.originAgents.value[id]?.title;
    return named ?? `${words.value.Agent} ${id.slice(0, 6)}`;
};

// Grouped by who wrote it rather than by repository: "who changed this" is the maker's first question, and a project
// with one repository — which is most of them — would make repository headings say nothing.
const groups = computed<readonly OriginGroup[]>(() => {
    const byOrigin = new Map<string, ChangedFile[]>();
    for (const repo of scannable.value) {
        for (const file of fileRows(repo)) {
            const id = originsOf(repo, file.path)[0] ?? YOURS;
            byOrigin.set(id, [...(byOrigin.get(id) ?? []), file]);
        }
    }
    const yours = byOrigin.get(YOURS) ?? [];
    byOrigin.delete(YOURS);
    // Assistants first, busiest first; the owner's own edits close the list, where they read as the remainder.
    const landed = [...byOrigin]
        .toSorted(([leftId, left], [rightId, right]) => right.length - left.length || (leftId < rightId ? -1 : 1))
        .map(([id, files]) => ({ id, title: titleOf(id), files }));
    return yours.length === 0 ? landed : [...landed, { id: YOURS, title: t(`workspace.savePanel.ownEdits`), files: yours }];
});

// What the tree holds, not what the list drew: the count includes conflicts and whatever the daemon truncated, which
// is what a save records. Every "is there anything here" question below reads it.
const pending = computed(() => changes.count.value);

// Opens on the click, not on the fetched answer: the row already carries everything the tab needs to draw itself.
const openDiff = (file: ChangedFile, mode: OpenMode): void => {
    const tab = {
        key: `working:${file.repo}:${file.side}`,
        scope: file.repo,
        label: file.label,
        status: file.status,
        path: file.path,
        ...diffRawUrls({ source: `working`, repo: file.repo, side: file.side }, file.path, file.status),
    };
    emit(`open-diff`, { ...tab, pending: true }, mode);
    void changes.fileDiff(file.repo, file.path, file.side).then((body) => fillDiff({ ...tab, ...body }));
};

// WHAT A SAVE RECORDS, and under what sentence.

const messageOf = (id: string): LandedMessage | undefined =>
    landedMessage(
        fleet.value.find((agent) => agent.id === id),
        changes.originAgents.value[id],
    );
const saving = computed(() => savedMessage(scannable.value, messageOf));
// The sentence is written by the commit-message model at land time, so right after a land there is a window where it
// is still coming. Named here so the line can say so rather than showing the constant it would fall back to.
const describing = computed(() => {
    const only = soleOrigin(scannable.value);
    return only !== undefined && draftRunning(fleet.value.find((agent) => agent.id === only)?.landedMessageDraft) ? titleOf(only) : undefined;
});

// Every repository with something in it, whole: a save is never partial, which is what lets this panel have no index.
// A clean repository is in the list for its remote alone, and sending it a commit would spend a round trip on nothing.
const saveTargets = computed<readonly RepoTarget[]>(() =>
    scannable.value.filter((repo) => fileRows(repo).length > 0 || truncatedTotal(repo) > 0).map((repo) => ({ repo: repo.repo })),
);
// The daemon caps rows at 500 a repository. The save still records the whole tree, so the button counts what is there
// (changes.count), not what is drawn, and the list says what it left out rather than quietly showing less.
const notListed = computed(() => scannable.value.reduce((total, repo) => total + truncatedTotal(repo), 0));
const blockedByConflicts = computed(() => scannable.value.some((repo) => repo.conflicted.length > 0));
const savingNow = computed(() => changes.committing.value.length > 0);
const saveReady = computed(() => pending.value > 0 && !blockedByConflicts.value && !changes.actionBusy.value && !savingNow.value);
const saveFailure = computed(() => changes.failures.value.get(COMMIT_SCOPE));

const doSave = async (): Promise<void> => {
    if (!saveReady.value) {
        return;
    }
    // `true`: staging the whole tree first is what makes one press record everything, index or no index.
    await changes.commitRepos(saveTargets.value, saving.value.message, true);
};

// THROWING WORK AWAY. One pending ask at a time, spelled out before it runs; restore points are the net under it.

// The file a row's press is asking about, or `all` for the whole tree; undefined when nothing is being asked.
const pendingDiscard = ref<ChangedFile | "all" | undefined>(undefined);

// A card, not a strip under the button: the press that raises this can be a row 700px above the panel's floor, and a
// destructive question the reader scrolls past is not a question. Resolved once so the card and the run agree.
const discardAsk = computed(() => {
    const asked = pendingDiscard.value;
    if (asked === undefined) {
        return undefined;
    }
    const files = asked === `all` ? groups.value.flatMap((group) => group.files) : [asked];
    // A file no version holds has no copy anywhere; undoing it deletes it rather than rewinding it.
    const gone = files.filter((file) => file.status === `added`);
    return {
        what: asked === `all` ? `all ${plural(pending.value, `change`)}` : asked.label,
        gone: gone.map((file) => file.label),
        back: files.length - gone.length,
        // The counts are a floor while the daemon truncated the list; the act still covers everything.
        partial: asked === `all` && notListed.value > 0,
    };
});
const runDiscard = async (): Promise<void> => {
    const asked = pendingDiscard.value;
    pendingDiscard.value = undefined;
    if (asked === undefined) {
        return;
    }
    // An empty target is the whole repository. A named one sends both legs of a rename: an explicit path list is
    // passed to git verbatim, so undoing the new name alone would leave the old one deleted.
    await changes.discardGroups(
        asked === `all` ? saveTargets.value : [{ repo: asked.repo, paths: asked.from === undefined ? [asked.path] : [asked.path, asked.from] }],
    );
};

// BACKING UP, for the maker who cloned their project from somewhere. One button for git's four verbs, since the
// difference between push, publish and sync is not a distinction a maker has been offered.

const backupRepos = computed(() => scannable.value.filter((repo) => syncable(repo) && (ahead(repo) > 0 || behind(repo) > 0 || unpublished(repo))));
const backupCommits = computed(() => backupRepos.value.reduce((total, repo) => total + ahead(repo), 0));
const backupLine = computed<string | undefined>(() => {
    if (pushFlow.running.value) {
        return `Backing up…`;
    }
    return backupRepos.value.length === 0
        ? undefined
        : backupCommits.value === 0
          ? `Not backed up yet`
          : `${plural(backupCommits.value, `version`)} not backed up`;
});
// Through askSync, like every other door to a push: a second one would be a way past the checks a project asked for.
const doBackUp = (): void =>
    pushFlow.askSync(
        words.value.push,
        backupCommits.value > 0 ? plural(backupCommits.value, `version`) : `this ${words.value.repo}`,
        backupRepos.value.map((repo) => ({ repo: repo.repo, pull: behind(repo) > 0, push: ahead(repo) > 0 || unpublished(repo) })),
    );

// Every failure that isn't the save's own, named by the project it happened in.
const strayFailures = computed(() =>
    [...changes.failures.value].filter(([scope]) => scope !== COMMIT_SCOPE).map(([repo, failure]) => ({ repo, ...failure })),
);

const ROW_ACTION = `opacity-0 transition-opacity focus-visible:opacity-100 group-hover/file:opacity-100 max-md:opacity-100`;
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col">
        <!-- Nothing below is trustworthy when the read itself failed, so it leads. -->
        <Notice v-if="changes.error.value" tone="danger" class="mx-2 mt-2 shrink-0">{{
            t(`workspace.savePanel.couldntReadWhatChanged`, { error: changes.error.value })
        }}</Notice>

        <!-- The one press, above the list it covers. -->
        <div v-if="pending > 0" class="flex shrink-0 flex-col gap-1.5 p-2">
            <!-- `small`, like the developer panel's Commit and this panel's own footer: the primary action earns the
                 full width of a 270px column, not a taller weight than every other control on the screen. -->
            <Button
                size="small"
                class="w-full"
                :disabled="!saveReady"
                @click="doSave"
                v-tooltip.right="t(`workspace.savePanel.recordsEverythingBelowOne`)"
            >
                <Icon :name="savingNow ? `spinner` : `save`" :spin="savingNow" class="mr-1 text-2xs" />{{
                    savingNow
                        ? t(`workspace.savePanel.saving`)
                        : t(`workspace.savePanel.saveChanges`, { count: changes.count.value }, changes.count.value)
                }}
            </Button>
            <p v-if="blockedByConflicts" class="text-2xs text-danger">{{ t(`workspace.savePanel.twoEditsToSame`, { agent: words.agent }) }}</p>
            <!-- The sentence is the assistant's own, written when its work arrived; naming who wrote it is why it isn't anonymous. -->
            <p v-else-if="describing" class="flex items-center gap-1.5 text-2xs text-subtle">
                <Icon name="spinner" spin class="shrink-0 text-3xs" />
                <span class="min-w-0 truncate">{{ t(`workspace.savePanel.writingDescriptionSWork`, { describing }) }}</span>
            </p>
            <p v-else class="min-w-0 text-2xs text-subtle" v-tooltip.right.overflow="saving.message">
                {{ t(`workspace.savePanel.saved`) }}<span class="text-muted">{{ saving.message.split(`\n`)[0] }}</span
                >”
            </p>
            <Notice v-if="saveFailure" tone="danger" dismissLabel="Dismiss" @dismiss="changes.dismissFailure(COMMIT_SCOPE)">
                {{ saveFailure.detail }}
            </Notice>
        </div>

        <div class="min-h-0 flex-1 overflow-auto pb-1">
            <!-- Where the incoming rows will appear, so it reads as "on their way here". -->
            <p v-if="changes.landing.value" class="flex items-center gap-1.5 px-3 py-2 text-2xs text-link">
                <Icon name="spinner" spin class="shrink-0 text-3xs" />
                <span class="min-w-0 truncate" v-tooltip.right.overflow="`${changes.landing.value}…`">{{ changes.landing.value }}…</span>
            </p>
            <p v-if="!changes.loaded.value && !changes.error.value" class="px-3 py-2 text-2xs text-subtle">{{ t(`workspace.savePanel.looking`) }}</p>
            <p v-else-if="changes.loaded.value && pending === 0 && !changes.landing.value" class="px-3 py-2 text-2xs text-subtle">
                {{ t(`workspace.savePanel.everythingSaved`) }}
            </p>

            <section v-for="group in groups" :key="group.id" class="mt-1 first:mt-0">
                <div class="flex min-w-0 items-center gap-1.5 px-2 py-1">
                    <Icon :name="group.id === YOURS ? `user` : `sparkles`" class="shrink-0 text-2xs text-subtle" />
                    <span class="min-w-0 truncate text-2xs font-medium text-content" v-tooltip.right.overflow="group.title">{{ group.title }}</span>
                    <span class="shrink-0 text-2xs text-subtle">{{ group.files.length }}</span>
                </div>
                <div
                    v-for="file in group.files"
                    :key="file.key"
                    class="cv-file group/file flex min-w-0 items-center gap-1.5 rounded px-2 py-1 pl-4 transition-colors hover:bg-overlay"
                >
                    <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-1.5 text-left max-md:min-h-11"
                        @click="openDiff(file, 'preview')"
                        @dblclick="openDiff(file, 'keep')"
                        v-tooltip.right="t(`workspace.savePanel.openToSeeWhat`, { word: STATUS_MARK[file.status].word })"
                    >
                        <Icon :name="STATUS_MARK[file.status].icon" class="shrink-0 text-3xs" :class="STATUS_MARK[file.status].tone" />
                        <!-- Bidi isolation keeps a path's segments in order; the tooltip carries it whole. -->
                        <span class="min-w-0 truncate text-xs text-content" dir="rtl" v-tooltip.right.overflow="file.label"
                            ><bdi>{{ file.label }}</bdi></span
                        >
                    </button>
                    <button
                        type="button"
                        :class="ui.iconButton(ROW_ACTION)"
                        :disabled="changes.actionBusy.value"
                        @click="pendingDiscard = file"
                        v-tooltip.left="t(`workspace.savePanel.changesToFile`, { discard: words.discard })"
                        :aria-label="`${words.discard} ${file.label}`"
                    >
                        <Icon name="undo" class="text-2xs" />
                    </button>
                </div>
            </section>

            <!-- Said, not hidden: Save still records these, so a list that silently stopped at 500 would undercount what the press does. -->
            <p v-if="notListed > 0" class="px-2 py-1 pl-4 text-2xs text-subtle">
                {{ t(`workspace.savePanel.andMoreFiles`, { count: notListed }, notListed) }}
            </p>

            <!-- Repositories git refused to read: listed with its reason, and no button that would act on a guess. -->
            <div v-for="group in unscannable" :key="group.repo" class="mt-1 flex min-w-0 items-start gap-1.5 px-2 py-1">
                <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-danger" />
                <div class="min-w-0">
                    <p class="truncate text-xs text-content">{{ group.repo }}</p>
                    <p class="break-words text-2xs text-muted">{{ group.error }}</p>
                </div>
            </div>
        </div>

        <div v-if="pending > 0 || backupLine || strayFailures.length > 0" class="shrink-0 border-t border-line p-2">
            <div class="flex items-center gap-1.5">
                <Button
                    v-if="pending > 0"
                    size="small"
                    severity="secondary"
                    :disabled="changes.actionBusy.value || savingNow"
                    @click="pendingDiscard = `all`"
                    v-tooltip.right="t(`workspace.savePanel.putsEveryFileBack`)"
                >
                    <Icon name="undo" class="mr-1 text-2xs" />{{ words.discard }} {{ t(`workspace.savePanel.all`) }}
                </Button>
                <span class="flex-1"></span>
                <span v-if="backupLine" class="min-w-0 truncate text-2xs text-subtle">{{ backupLine }}</span>
                <Button
                    v-if="backupRepos.length > 0"
                    size="small"
                    severity="secondary"
                    :disabled="pushFlow.running.value || changes.actionBusy.value"
                    @click="doBackUp"
                    v-tooltip.left="t(`workspace.savePanel.sendsSavedVersionsTo`, { repo: words.repo })"
                >
                    <Icon name="cloud-upload" class="mr-1 text-2xs" />{{ words.push }}
                </Button>
            </div>
            <Notice
                v-for="failure in strayFailures"
                :key="failure.repo"
                tone="danger"
                class="mt-1.5"
                dismissLabel="Dismiss"
                @dismiss="changes.dismissFailure(failure.repo)"
            >
                {{ failure.repo }}: {{ failure.detail }}
            </Notice>
        </div>

        <Modal
            :open="discardAsk !== undefined"
            size="sm"
            :header="t(`workspace.savePanel.changes`, { discard: words.discard })"
            @update:open="pendingDiscard = undefined"
        >
            <template v-if="discardAsk">
                <p class="break-words text-xs text-content">{{ words.discard }} {{ discardAsk.what }}?</p>
                <p v-if="discardAsk.partial" class="mt-2 text-xs text-warning">
                    {{ t(`workspace.savePanel.moreChangesHereThan`) }}
                </p>
                <p v-if="discardAsk.back > 0" class="mt-2 text-xs text-muted">
                    {{ discardAsk.partial ? t(`workspace.savePanel.atLeast`) : `` }}
                    {{ t(`workspace.savePanel.filesGoBack`, { count: discardAsk.back }, discardAsk.back) }}
                </p>
                <!-- The one genuinely lossy half, named file by file: nothing has a copy of these. -->
                <div v-if="discardAsk.gone.length > 0" class="mt-2">
                    <p class="text-xs text-danger">
                        {{ discardAsk.partial ? t(`workspace.savePanel.atLeast`) : `` }}
                        {{ t(`workspace.savePanel.newFilesDeleted`, { count: discardAsk.gone.length }, discardAsk.gone.length) }}
                    </p>
                    <!-- No `dir="rtl"` here, unlike the sidebar rows: these wrap rather than truncate, so reversing them
                         would only push the list to the right margin. `bdi` still holds each path's segments in order. -->
                    <ul class="mt-1 max-h-24 overflow-auto">
                        <li v-for="path in discardAsk.gone" :key="path" class="break-all text-2xs text-muted">
                            <bdi>{{ path }}</bdi>
                        </li>
                    </ul>
                </div>
                <p class="mt-3 text-2xs text-subtle">
                    <Icon name="shield" class="mr-0.5 text-[0.6rem]" />{{ t(`workspace.savePanel.versionHowThingsNow`) }} {{ words.restorePoints }}.
                </p>
            </template>
            <template #footer>
                <Button size="small" severity="secondary" :text="true" :label="t(`workspace.savePanel.keep`)" @click="pendingDiscard = undefined" />
                <Button size="small" severity="danger" @click="runDiscard">{{ words.discard }}</Button>
            </template>
        </Modal>
    </div>
</template>

<style scoped>
/* Cheap windowing without a virtual scroller: content-visibility skips paint for off-screen rows. */
.cv-file {
    content-visibility: auto;
    contain-intrinsic-size: auto 28px;
}
</style>
