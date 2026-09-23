<script setup lang="ts">
import type { ChangeStatus, IconName } from "@intentic/ui";
import { Button, Modal, Notice, ui } from "@intentic/ui";
import { basename, parentDir } from "@intentic/ui/path";
import { useWorkspaceTabs } from "../../tabs/useWorkspaceTabs";
import type { DiffPayload } from "@intentic/extension-api";
import type { LandedMessage, RepoChanges } from "@intentic/api-contract";
import { computed } from "vue";
import { useVocabulary } from "../../../../core-views/vocabulary";
import { useAgents } from "../../../agents/fleet/useAgents";
import { type ChangedFile, fileRows } from "./changedFiles";
import { draftRunning, landedMessage, originsOf, YOURS } from "../changeOrigins";
import { diffRawUrls } from "../diffRaw";
import { savedMessage, soleOrigin } from "./savedMessage";
import { COMMIT_SCOPE, useChanges } from "../useChanges";
import { useSaveActions } from "./useSaveActions";
import type { OpenMode } from "../../tabs/workspaceTabs";
import { useT } from "@intentic/ui/i18n";

// The maker's half of the Changes sidebar, over the same read the developer's ReviewPanel uses. Everything git asks a
// developer to decide is decided here instead: there is no index (a save records the whole tree), no message to write
// (savedMessage.ts picks one), and no per-repo remote dashboard. What is left is the two questions a maker actually
// has — what changed, and do I keep it — plus the diff behind every row.
//
// The shape follows those two questions: one press at the top, then headings that name WHO changed something with
// their files under them. Presses that act on everything (throw it all away, back it up) are not here at all — they
// ride the sidebar's icon row, from SaveActions.vue.

const t = useT();

const changes = useChanges();
const words = useVocabulary();
const actions = useSaveActions();
const { fleet } = useAgents();

const emit = defineEmits<{ "open-diff": [payload: DiffPayload, mode: OpenMode] }>();
// The body lands in the tabs store directly, not through the host: on a phone the host swaps this panel out for the
// viewer the moment the diff opens, and an emit from an unmounted panel reaches nobody.
const { fillDiff } = useWorkspaceTabs();

// Repos git could read; the rest are listed with their reason and no actions, as in the developer's panel.
const scannable = computed(() => changes.repos.value.filter((repo) => repo.error === undefined));
const unscannable = computed(() => changes.repos.value.filter((repo) => repo.error !== undefined));

// Git's one-letter status is a developer's alphabet; a maker gets a glyph, and under the name the same thing in a
// word, since a coloured pencil is not self-explanatory to someone who has never read a diff.
const STATUS_MARK: Record<ChangeStatus, { readonly icon: IconName; readonly tone: string }> = {
    added: { icon: `plus`, tone: `text-success` },
    modified: { icon: `pencil`, tone: `text-warning` },
    deleted: { icon: `eraser`, tone: `text-danger` },
    renamed: { icon: `arrow-right`, tone: `text-muted` },
    "type-changed": { icon: `repeat`, tone: `text-muted` },
    conflicted: { icon: `exclamation-triangle`, tone: `text-danger` },
};

// One literal `t()` per status rather than a built key, so the catalogue check can see every word that ships.
const STATUS_WORD = computed<Record<ChangeStatus, string>>(() => ({
    added: t(`workspace.savePanel.statusNew`),
    modified: t(`workspace.savePanel.statusChanged`),
    deleted: t(`shared.removed`),
    renamed: t(`workspace.savePanel.statusRenamed`),
    "type-changed": t(`workspace.savePanel.statusChanged`),
    conflicted: t(`workspace.savePanel.statusClashes`),
}));

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

const blockedByConflicts = computed(() => scannable.value.some((repo: RepoChanges) => repo.conflicted.length > 0));
const savingNow = computed(() => changes.committing.value.length > 0);
const saveReady = computed(() => pending.value > 0 && !blockedByConflicts.value && !changes.actionBusy.value && !savingNow.value);
const saveFailure = computed(() => changes.failures.value.get(COMMIT_SCOPE));

const doSave = async (): Promise<void> => {
    if (!saveReady.value) {
        return;
    }
    // `true`: staging the whole tree first is what makes one press record everything, index or no index.
    await changes.commitRepos(actions.dirtyRepos.value, saving.value.message, true);
};

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

        <!-- The one press, above the list it covers. It shrink-wraps its label: this is the only button on the panel,
             so nothing needs the column's full width to be found, and a bar that wide reads as a banner. -->
        <div v-if="pending > 0" class="flex shrink-0 flex-col items-start gap-1 px-2 pb-2 pt-2">
            <Button size="small" :disabled="!saveReady" @click="doSave" v-tooltip.right="t(`workspace.savePanel.recordsEverythingBelowOne`)">
                <Icon :name="savingNow ? `spinner` : `save`" :spin="savingNow" class="mr-1 text-2xs" />{{
                    savingNow
                        ? t(`workspace.savePanel.saving`)
                        : t(`workspace.savePanel.saveChanges`, { count: changes.count.value }, changes.count.value)
                }}
            </Button>
            <p v-if="blockedByConflicts" class="text-2xs text-danger">{{ t(`workspace.savePanel.twoEditsToSame`, { agent: words.agent }) }}</p>
            <!-- The sentence is the assistant's own, written when its work arrived; naming who wrote it is why it isn't anonymous. -->
            <p v-else-if="describing" class="flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
                <Icon name="spinner" spin class="shrink-0 text-3xs" />
                <span class="min-w-0 truncate">{{ t(`workspace.savePanel.writingDescriptionSWork`, { describing }) }}</span>
            </p>
            <p v-else class="min-w-0 max-w-full truncate text-2xs text-subtle" v-tooltip.right.overflow="saving.message">
                {{ t(`workspace.savePanel.willBeCalled`) }}<span class="text-muted">{{ saving.message.split(`\n`)[0] }}</span
                >”
            </p>
        </div>

        <!-- What a press failed at, held above the list rather than under it: the list is what the failure is about. -->
        <div v-if="saveFailure || strayFailures.length > 0" class="flex shrink-0 flex-col gap-1.5 px-2 pb-2">
            <Notice v-if="saveFailure" tone="danger" dismissLabel="Dismiss" @dismiss="changes.dismissFailure(COMMIT_SCOPE)">
                {{ saveFailure.detail }}
            </Notice>
            <Notice
                v-for="failure in strayFailures"
                :key="failure.repo"
                tone="danger"
                dismissLabel="Dismiss"
                @dismiss="changes.dismissFailure(failure.repo)"
            >
                {{ failure.repo }}: {{ failure.detail }}
            </Notice>
        </div>

        <div class="min-h-0 flex-1 overflow-auto pb-2">
            <!-- Where the incoming rows will appear, so it reads as "on their way here". -->
            <p v-if="changes.landing.value" class="flex items-center gap-1.5 px-3 py-2 text-2xs text-link">
                <Icon name="spinner" spin class="shrink-0 text-3xs" />
                <span class="min-w-0 truncate" v-tooltip.right.overflow="`${changes.landing.value}…`">{{ changes.landing.value }}…</span>
            </p>
            <p v-if="!changes.loaded.value && !changes.error.value" class="px-3 py-2 text-2xs text-subtle">{{ t(`workspace.savePanel.looking`) }}</p>
            <p
                v-else-if="changes.loaded.value && pending === 0 && !changes.landing.value"
                class="flex items-center gap-1.5 px-3 py-2 text-xs text-subtle"
            >
                <Icon name="check" class="shrink-0 text-2xs text-success" />{{ t(`workspace.savePanel.everythingSaved`) }}
            </p>

            <section v-for="group in groups" :key="group.id">
                <!-- Sticky, so the name of whoever changed these files stays overhead while their files scroll past.
                     A step up the type scale from the names under it, not down: the old heading was the SMALLEST text
                     in the panel, which is what stopped it reading as one. -->
                <div class="sticky top-0 z-10 flex min-w-0 items-center gap-2 border-b border-line bg-card px-2 py-2">
                    <Icon :name="group.id === YOURS ? `user` : `sparkles`" class="shrink-0 text-xs text-subtle" />
                    <span class="min-w-0 flex-1 truncate text-sm font-semibold text-content" v-tooltip.right.overflow="group.title">{{
                        group.title
                    }}</span>
                    <span class="shrink-0 text-2xs text-subtle">{{
                        t(`workspace.savePanel.fileCount`, { count: group.files.length }, group.files.length)
                    }}</span>
                </div>
                <!-- The rail is the other half of the heading: it says these rows belong to the name above them, which
                     indentation alone stops saying the moment a heading scrolls off. -->
                <div
                    v-for="file in group.files"
                    :key="file.key"
                    class="cv-file group/file ml-3.5 flex min-w-0 items-start gap-2 border-l border-line py-1.5 pl-2 pr-1 transition-colors hover:bg-overlay"
                >
                    <button
                        type="button"
                        class="flex min-w-0 flex-1 items-start gap-2 text-left max-md:min-h-11"
                        @click="openDiff(file, 'preview')"
                        @dblclick="openDiff(file, 'keep')"
                        v-tooltip.right="t(`workspace.savePanel.openToSeeWhat`, { word: STATUS_WORD[file.status] })"
                    >
                        <Icon :name="STATUS_MARK[file.status].icon" class="mt-px shrink-0 text-2xs" :class="STATUS_MARK[file.status].tone" />
                        <!-- Name first and whole where it fits, the folder under it: a maker recognises "Offer.docx",
                             not "drop/2026/Offer.docx", and the tooltip carries the path the row had to cut. -->
                        <span class="min-w-0 flex-1">
                            <!-- The tooltip hangs on the name, the only part that truncates to nothing a reader can use. -->
                            <span class="block truncate text-xs text-content" v-tooltip.right.overflow="file.label">{{ basename(file.label) }}</span>
                            <span class="block truncate text-3xs">
                                <span :class="STATUS_MARK[file.status].tone">{{ STATUS_WORD[file.status] }}</span>
                                <span v-if="parentDir(file.label)" class="text-subtle"> · {{ parentDir(file.label) }}</span>
                            </span>
                        </span>
                    </button>
                    <button
                        type="button"
                        :class="ui.iconButton(ROW_ACTION, `hover:bg-danger/10 hover:text-danger`)"
                        :disabled="changes.actionBusy.value"
                        @click="actions.ask(file)"
                        v-tooltip.left="t(`workspace.savePanel.changesToFile`, { discard: words.discard })"
                        :aria-label="`${words.discard} ${file.label}`"
                    >
                        <Icon name="undo" class="text-2xs" />
                    </button>
                </div>
            </section>

            <!-- Said, not hidden: Save still records these, so a list that silently stopped at 500 would undercount what the press does. -->
            <p v-if="actions.notListed.value > 0" class="px-3 py-1.5 text-2xs text-subtle">
                {{ t(`workspace.savePanel.andMoreFiles`, { count: actions.notListed.value }, actions.notListed.value) }}
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

        <Modal
            :open="actions.discardAsk.value !== undefined"
            size="sm"
            :header="t(`workspace.savePanel.changes`, { discard: words.discard })"
            @update:open="actions.dismiss()"
        >
            <template v-if="actions.discardAsk.value">
                <p class="break-words text-xs text-content">{{ words.discard }} {{ actions.discardAsk.value.what }}?</p>
                <p v-if="actions.discardAsk.value.partial" class="mt-2 text-xs text-warning">
                    {{ t(`workspace.savePanel.moreChangesHereThan`) }}
                </p>
                <p v-if="actions.discardAsk.value.back > 0" class="mt-2 text-xs text-muted">
                    {{ actions.discardAsk.value.partial ? t(`shared.atLeast`) : `` }}
                    {{ t(`workspace.savePanel.filesGoBack`, { count: actions.discardAsk.value.back }, actions.discardAsk.value.back) }}
                </p>
                <!-- The one genuinely lossy half, named file by file: nothing has a copy of these. -->
                <div v-if="actions.discardAsk.value.gone.length > 0" class="mt-2">
                    <p class="text-xs text-danger">
                        {{ actions.discardAsk.value.partial ? t(`shared.atLeast`) : `` }}
                        {{
                            t(
                                `workspace.savePanel.newFilesDeleted`,
                                { count: actions.discardAsk.value.gone.length },
                                actions.discardAsk.value.gone.length,
                            )
                        }}
                    </p>
                    <!-- No `dir="rtl"` here, unlike the sidebar rows: these wrap rather than truncate, so reversing them
                         would only push the list to the right margin. `bdi` still holds each path's segments in order. -->
                    <ul class="mt-1 max-h-24 overflow-auto">
                        <li v-for="path in actions.discardAsk.value.gone" :key="path" class="break-all text-2xs text-muted">
                            <bdi>{{ path }}</bdi>
                        </li>
                    </ul>
                </div>
                <p class="mt-3 text-2xs text-subtle">
                    <Icon name="shield" class="mr-0.5 text-[0.6rem]" />{{ t(`workspace.savePanel.versionHowThingsNow`) }} {{ words.restorePoints }}.
                </p>
            </template>
            <template #footer>
                <Button size="small" severity="secondary" :text="true" :label="t(`workspace.savePanel.keep`)" @click="actions.dismiss()" />
                <Button size="small" severity="danger" @click="actions.runDiscard()">{{ words.discard }}</Button>
            </template>
        </Modal>
    </div>
</template>

<style scoped>
/* Cheap windowing without a virtual scroller: content-visibility skips paint for off-screen rows. */
.cv-file {
    content-visibility: auto;
    contain-intrinsic-size: auto 40px;
}
</style>
