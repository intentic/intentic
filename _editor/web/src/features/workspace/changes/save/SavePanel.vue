<script setup lang="ts">
import type { ChangeStatus, IconName, Tip } from "@intentic/ui";
import { Button, Modal, Notice, ui, useDevice } from "@intentic/ui";
import { useWorkspaceTabs } from "../../tabs/useWorkspaceTabs";
import type { DiffPayload } from "@intentic/extension-api";
import type { LandedMessage, RepoChanges } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { useVocabulary } from "../../../../workbench/views/vocabulary";
import { useAgents } from "../../../agents/fleet/useAgents";
import { type ChangedFile, fileRows } from "./changedFiles";
import { askingModel, draftRunning, landedMessage, originHue, originsOf, YOURS } from "../changeOrigins";
import { diffRawUrls } from "../diffRaw";
import { savedMessage, soleOrigin } from "./savedMessage";
import { COMMIT_SCOPE, useChanges } from "../useChanges";
import { useSaveActions } from "./useSaveActions";
import type { OpenMode } from "../../tabs/workspaceTabs";
import { useT } from "@intentic/ui/i18n";
import CommitField from "../commit/CommitField.vue";
import ChangeRowName from "../../../../components/ChangeRowName.vue";
import ProviderLogo from "../../../chat/accounts/ProviderLogo.vue";

// The maker's half of the Changes sidebar, over the same read the developer's ReviewPanel uses. Everything git asks a
// developer to decide is decided here instead: there is no index (a save records the whole tree), no message to write
// (savedMessage.ts picks one), and no per-repo remote dashboard. What is left is the two questions a maker actually
// has — what changed, and do I keep it — plus the diff behind every row.
//
// It wears the developer's layout (ReviewPanel.vue) so the two read as one product: the same field on top (CommitField),
// one bar of presses under it, then the list. The field is optional here: its placeholder is the name the save will
// use anyway, and typing replaces it. The bar holds Save and, for a project with somewhere to back up to, Back up. The
// list is grouped by WHO changed something, each heading folding its files and throwing them away together.

const t = useT();

const changes = useChanges();
const words = useVocabulary();
const actions = useSaveActions();
const { fleet } = useAgents();
const { mobile } = useDevice();

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

const providerOf = (id: string): string | undefined =>
    fleet.value.find((agent) => agent.id === id)?.provider ?? changes.originAgents.value[id]?.provider;

// Folded headings, by origin id. A heading that leaves and comes back opens again, which is what a new land wants.
const folded = ref<ReadonlySet<string>>(new Set());
const toggleGroup = (id: string): void => {
    const next = new Set(folded.value);
    if (!next.delete(id)) {
        next.add(id);
    }
    folded.value = next;
};

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

// A heading's undo covers its files; when it is the only heading, it covers the tree, which also reaches the files the
// daemon left off the list.
const undoGroup = (group: OriginGroup): void => actions.ask(groups.value.length === 1 ? `all` : { who: group.title, files: group.files });

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
// What the save is called: the maker's own words when they typed some, the suggestion otherwise.
const typedName = computed(() => actions.versionName.value.trim());
const savedAs = computed(() => (typedName.value === `` ? saving.value.message : actions.versionName.value));

// The sentence is written by the commit-message model at land time, so right after a land there is a window where it
// is still coming. The draft is the field's to report (its mark), and the placeholder names who is writing it.
const soleId = computed(() => soleOrigin(scannable.value));
const soleDraft = computed(() =>
    soleId.value === undefined ? undefined : fleet.value.find((agent) => agent.id === soleId.value)?.landedMessageDraft,
);
const namePlaceholder = computed(() => {
    if (soleId.value !== undefined && draftRunning(soleDraft.value)) {
        const model = askingModel(soleDraft.value);
        return model === undefined
            ? t(`workspace.savePanel.writingDescriptionSWork`, { describing: titleOf(soleId.value) })
            : t(`workspace.savePanel.modelDescribing`, { model });
    }
    // The landing's own sentence, as the name a save left alone will carry; otherwise an invitation, since the
    // constant it would fall back to reads as an instruction in a field.
    return saving.value.from === undefined ? t(`workspace.savePanel.describeVersion`) : saving.value.message.split(`\n`)[0]!;
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
    await changes.commitRepos(actions.dirtyRepos.value, savedAs.value, true);
    // Keeps the name on failure — it's the one thing here the maker typed by hand.
    if (changes.failures.value.get(COMMIT_SCOPE) === undefined) {
        actions.versionName.value = ``;
    }
};
// Save's hover: what a version is, and what this one will be called.
const saveTip = computed(
    (): Tip => ({
        title: t(`workspace.savePanel.oneVersion`),
        rows: [{ label: t(`workspace.savePanel.savedAs`), value: savedAs.value.split(`\n`)[0]! }],
        note: t(`workspace.savePanel.canGoBack`),
    }),
);
// The bar stands whenever either press has something to do.
const actionBar = computed(() => pending.value > 0 || actions.backupRepos.value.length > 0);


// Every failure that isn't the save's own, named by the project it happened in.
const strayFailures = computed(() =>
    [...changes.failures.value].filter(([scope]) => scope !== COMMIT_SCOPE).map(([repo, failure]) => ({ repo, ...failure })),
);

// The developer's grid (ReviewPanel.vue): every leading glyph (chevron, status mark) in one 10px slot, and the trailing
// presses one size on every row, so their columns run straight down from a heading to each file.
const LEAD = `flex w-2.5 shrink-0 items-center justify-center`;
const rowGlyph = (...classes: string[]): string =>
    ui.iconButton({ size: mobile.value ? `lg` : `xs`, tone: `muted` }, `shrink-0 self-center disabled:opacity-40`, ...classes);
// Throwing away waits for a hover on a pointer, and is always there on touch, which has none.
const HEAD_ACTION = `opacity-0 transition-opacity focus-visible:opacity-100 group-hover/head:opacity-100 max-md:opacity-100`;
const ROW_ACTION = `opacity-0 transition-opacity focus-visible:opacity-100 group-hover/file:opacity-100 max-md:opacity-100`;
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col">
        <!-- Nothing below is trustworthy when the read itself failed, so it leads. -->
        <Notice v-if="changes.error.value" tone="danger" class="mx-2 mt-2 shrink-0">{{
            t(`workspace.savePanel.couldntReadWhatChanged`, { error: changes.error.value })
        }}</Notice>

        <!-- The developer's commit box, in a maker's words: the version's name, then one bar of presses. A container, so
             the bar thins against its own width (sidebar, phone or pop-out) rather than the window's. -->
        <div v-if="actionBar" class="@container flex shrink-0 flex-col gap-1.5" :class="pending > 0 ? `p-2` : `px-2 py-1.5`">
            <CommitField
                v-if="pending > 0"
                v-model="actions.versionName.value"
                :placeholder="namePlaceholder"
                :label="t(`workspace.savePanel.versionName`)"
                :draft="soleDraft"
                :draft-title="soleId === undefined ? undefined : titleOf(soleId)"
                @submit="doSave"
            />
            <div class="flex items-center justify-end gap-1">
                <Button
                    v-if="pending > 0"
                    size="small"
                    tone="success"
                    thumb
                    class="shrink-0 whitespace-nowrap"
                    :disabled="!saveReady"
                    @click="doSave"
                    v-tooltip.right="saveTip"
                    :aria-label="t(`workspace.savePanel.saveChanges`, { count: pending }, pending)"
                >
                    <Icon :name="savingNow ? `spinner` : `save`" :spin="savingNow" />{{
                        savingNow ? t(`workspace.savePanel.saving`) : t(`ui.action.save`)
                    }}
                    <!-- Everything, said on the press itself, as Commit says what it records. -->
                    <span v-if="!savingNow" class="tabular-nums opacity-70" aria-hidden="true">{{ pending }}</span>
                </Button>
                <!-- After Save, in the order the two happen; the push flow's own card asks before anything leaves. Its word
                     gives way first in a narrow box: the arrow and the count carry it, the hover keeps the whole of it. -->
                <Button
                    v-if="actions.backupRepos.value.length > 0"
                    size="small"
                    :tier="pending > 0 ? `boring` : `accent`"
                    thumb
                    class="shrink-0 whitespace-nowrap"
                    :disabled="actions.backingUp.value || changes.actionBusy.value"
                    @click="actions.doBackUp()"
                    v-tooltip.bottom="actions.backupTip.value"
                    :aria-label="words.push"
                >
                    <Icon :name="actions.backingUp.value ? `spinner` : `cloud-upload`" :spin="actions.backingUp.value" />
                    <span v-if="actions.backingUp.value">{{ t(`workspace.savePanel.backingUp`) }}</span>
                    <template v-else>
                        <span class="hidden @2xs:inline">{{ words.push }}</span>
                        <span v-if="actions.backupCommits.value > 0" class="tabular-nums opacity-70" aria-hidden="true">{{
                            actions.backupCommits.value
                        }}</span>
                    </template>
                </Button>
            </div>
            <!-- What stops Save, in full: the one line here a maker has to act on, so it wraps rather than truncates. -->
            <p v-if="pending > 0 && blockedByConflicts" class="text-2xs text-danger">
                {{ t(`workspace.savePanel.twoEditsToSame`, { agent: words.agent }) }}
            </p>
            <!-- What a press failed at, held under the presses rather than under the list: the list is what it's about. -->
            <Notice v-if="saveFailure" tone="danger" :dismissLabel="t(`ui.action.dismiss`)" @dismiss="changes.dismissFailure(COMMIT_SCOPE)">
                {{ saveFailure.detail }}
            </Notice>
        </div>

        <!-- Every failure that isn't the save's own, named by the project it happened in. -->
        <div v-if="strayFailures.length > 0" class="flex shrink-0 flex-col gap-1.5 px-2 pb-2">
            <Notice
                v-for="failure in strayFailures"
                :key="failure.repo"
                tone="danger"
                :dismissLabel="t(`ui.action.dismiss`)"
                @dismiss="changes.dismissFailure(failure.repo)"
            >
                {{ failure.repo }}: {{ failure.detail }}
            </Notice>
        </div>

        <div class="min-h-0 flex-1 overflow-auto pb-2">
            <!-- Where the incoming rows will appear, so it reads as "on their way here". -->
            <p v-if="changes.landing.value" class="flex items-center gap-1.5 px-2 py-2 text-2xs text-link">
                <span :class="LEAD"><Icon name="spinner" spin class="text-2xs" /></span>
                <span class="min-w-0 truncate" v-tooltip.right.overflow="`${changes.landing.value}…`">{{ changes.landing.value }}…</span>
            </p>
            <p v-if="!changes.loaded.value && !changes.error.value" class="px-2 py-2 text-2xs text-subtle">{{ t(`workspace.savePanel.looking`) }}</p>
            <p
                v-else-if="changes.loaded.value && pending === 0 && !changes.landing.value"
                class="flex items-center gap-1.5 px-2 py-2 text-2xs text-subtle"
            >
                <span :class="LEAD"><Icon name="check" class="text-2xs text-success" /></span>{{ t(`workspace.savePanel.everythingSaved`) }}
            </p>

            <section v-for="group in groups" :key="group.id" class="px-1">
                <!-- Who changed these, as the developer's repository row: fold, badge, name, count, and the press that
                     throws them away. Sticky, so the name stays overhead while its files scroll past. -->
                <div class="group/head sticky top-0 z-10 bg-card">
                    <div class="ui-row-select flex items-center gap-1 rounded-md pr-1">
                        <button
                            type="button"
                            class="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-1 text-left max-md:min-h-11"
                            :aria-expanded="!folded.has(group.id)"
                            @click="toggleGroup(group.id)"
                        >
                            <span :class="LEAD">
                                <Icon class="text-2xs text-subtle" :name="folded.has(group.id) ? `chevron-right` : `chevron-down`" />
                            </span>
                            <span
                                class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                                :class="group.id === YOURS ? `bg-overlay text-muted` : originHue(group.id).chip"
                                aria-hidden="true"
                            >
                                <Icon v-if="group.id === YOURS" name="user" class="text-[0.55rem]" />
                                <ProviderLogo v-else-if="providerOf(group.id)" :provider="providerOf(group.id)!" class="text-[0.6rem]" />
                                <Icon v-else name="sparkles" class="text-[0.55rem]" />
                            </span>
                            <span class="min-w-0 truncate text-xs font-medium text-content" v-tooltip.top.overflow="group.title">{{ group.title }}</span>
                        </button>
                        <span
                            class="shrink-0 px-0.5 text-2xs tabular-nums text-muted"
                            :aria-label="t(`workspace.savePanel.fileCount`, { count: group.files.length }, group.files.length)"
                            >{{ group.files.length }}</span
                        >
                        <button
                            type="button"
                            :class="rowGlyph(HEAD_ACTION)"
                            :disabled="changes.actionBusy.value || savingNow"
                            @click="undoGroup(group)"
                            v-tooltip.top="{ title: t(`workspace.savePanel.changes`, { discard: words.discard }), note: t(`workspace.savePanel.backToLastVersion`) }"
                            :aria-label="`${t(`workspace.savePanel.changes`, { discard: words.discard })}: ${group.title}`"
                        >
                            <Icon name="undo" class="text-2xs" />
                        </button>
                    </div>
                </div>
                <template v-if="!folded.has(group.id)">
                    <!-- One line a file, as the developer's rows: the mark under the badge, the name, then the folder dimmed.
                         Changed is what nearly every row is, so only the other states say so in a word. -->
                    <div
                        v-for="file in group.files"
                        :key="file.key"
                        class="cv-file ui-row-select group/file flex items-stretch gap-1 rounded pr-1 transition-colors"
                    >
                        <button
                            type="button"
                            class="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pl-5 text-left max-md:min-h-11"
                            :aria-label="`${t(`workspace.savePanel.seeChanges`)}: ${file.label}, ${STATUS_WORD[file.status]}`"
                            @click="openDiff(file, 'preview')"
                            @dblclick="openDiff(file, 'keep')"
                        >
                            <span :class="LEAD"><Icon :name="STATUS_MARK[file.status].icon" class="text-2xs" :class="STATUS_MARK[file.status].tone" /></span>
                            <ChangeRowName :path="file.label" :label="file.label" :named="false" />
                            <span v-if="file.status !== `modified`" class="shrink-0 text-2xs" :class="STATUS_MARK[file.status].tone">{{
                                STATUS_WORD[file.status]
                            }}</span>
                        </button>
                        <button
                            type="button"
                            :class="rowGlyph(ROW_ACTION, `max-md:ml-2`)"
                            :disabled="changes.actionBusy.value"
                            @click="actions.ask(file)"
                            v-tooltip.top="t(`workspace.savePanel.changes`, { discard: words.discard })"
                            :aria-label="`${words.discard} ${file.label}`"
                        >
                            <Icon name="undo" class="text-2xs" />
                        </button>
                    </div>
                </template>
            </section>

            <!-- Said, not hidden: Save still records these, so a list that silently stopped at 500 would undercount what the press does. -->
            <p v-if="actions.notListed.value > 0" class="px-2 py-1.5 pl-6 text-2xs text-subtle">
                {{ t(`workspace.savePanel.andMoreFiles`, { count: actions.notListed.value }, actions.notListed.value) }}
            </p>

            <!-- Repositories git refused to read: listed with its reason, and no button that would act on a guess. -->
            <div v-for="group in unscannable" :key="group.repo" class="mt-1 flex min-w-0 items-start gap-1.5 px-2 py-1">
                <span :class="LEAD" class="mt-0.5"><Icon name="exclamation-triangle" class="text-2xs text-danger" /></span>
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
                    {{ actions.discardAsk.value.partial ? t(`workspace.words.atLeast`) : `` }}
                    {{ t(`workspace.savePanel.filesGoBack`, { count: actions.discardAsk.value.back }, actions.discardAsk.value.back) }}
                </p>
                <!-- The one genuinely lossy half, named file by file: nothing has a copy of these. -->
                <div v-if="actions.discardAsk.value.gone.length > 0" class="mt-2">
                    <p class="text-xs text-danger">
                        {{ actions.discardAsk.value.partial ? t(`workspace.words.atLeast`) : `` }}
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
                <Button size="small" tier="quiet" :label="t(`workspace.savePanel.keep`)" @click="actions.dismiss()" />
                <Button size="small" tone="danger" @click="actions.runDiscard()">{{ words.discard }}</Button>
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
