<script setup lang="ts">
import type { SkillDraft, SkillSummary } from "@intentic/sandbox-contract/schemas/settings";
import { allLoaded, type Loaded } from "@intentic/extension-api";
import { Await, BrandMark, CopyButton, formatCompact, MarkdownDocument, timeAgo, ui } from "@intentic/ui";
import { useQueryClient } from "@tanstack/vue-query";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { rpcKey } from "../../../../lib/queryKeys";
import { here, page } from "../../../../lib/routes/links";
import { useCapabilities } from "../../../../models/capabilities/useCapabilities";
import { useExtensions } from "../../../../models/extensions/useExtensions";
import { useSkills } from "../../environment/useSkills";
import SkillDelete from "./SkillDelete.vue";
import SkillEditor from "./SkillEditor.vue";
import { dropDraft, heldDraft, holdDraft, NEW_SKILL } from "./skillDrafts";
import { triggerDoubt, triggerDoubtWords } from "./skillList";
import { skillVisual } from "./skillVisual";
import { provenanceOf } from "./skillWords";
import { useT } from "@intentic/ui/i18n";

// One skill as a page: a tab of the side panel beside whatever section is open (SideSkill.vue), a sheet over Settings on a
// phone (AgentSkills). The reader's own skill is written where it is read (<SkillEditor>); anybody else's is read as the
// document it is. Beside it, the facts a reader asks of a skill and the list had no room for: whether turns still reach
// for it, what it costs when they do, where it came from, and the files in its folder, each opening as a file of the
// workspace when the folder is what the agent reads (a dropped skill is edited that way, as the file it is). What
// becomes of the tab or sheet holding it (closed, replaced, kept) is its host's to decide, from what the page reports.

const t = useT();

const {
    skill: id,
    name,
    host = `side`,
} = defineProps<{
    /** The daemon's id for the skill, or NEW_SKILL for one being written. Fixed for the page's life: a tab is keyed by it. */
    skill: string;
    /** The name the tab was opened under, shown while the list is still being read. */
    name: string;
    /** What holds the page: a side tab scrolls on its own and titles it; a sheet has its own title bar and scroller. */
    host?: `side` | `sheet`;
}>();

const emit = defineEmits<{
    /** Deleted, or a new one cancelled: there is nothing left to show. */
    gone: [];
    /** A new skill was saved under this name; its page is now that skill's. */
    saved: [name: string];
    /** A file of its folder was asked for, as a workspace path. */
    "open-file": [path: string];
    /** Something was typed that is not saved yet: a host that replaces what it shows on the next open should keep this. */
    edited: [];
}>();

const creating = id === NEW_SKILL;
const queryClient = useQueryClient();
const { skills, settings, loaded: listLoaded, save, remove, setEnabled } = useSkills();
const { capabilities } = useCapabilities();
const { enabled: enabledExtensions } = useExtensions();

const summary = computed<SkillSummary | undefined>(() => skills.value.find((entry) => entry.id === id));
const { query: bodyQuery, loaded: bodyLoaded } = useSandboxQuery({ ...rpcQuery(`skills.read`, { id }), enabled: !creating });
const read = computed(() => bodyQuery.data.value);
// A new skill waits on the list alone (the names it may not take); a saved one on its body too.
const loaded = computed<Loaded<unknown>>(() => (creating ? listLoaded.value : allLoaded([listLoaded.value, bodyLoaded.value])));

const visual = computed(() =>
    summary.value === undefined ? undefined : skillVisual(summary.value, { capabilities: capabilities.value, extensions: enabledExtensions.value }),
);
const disabled = computed(() => settings.value === undefined);

// --- Writing: the reader's own skill, or a new one -------------------------------------------------------------------

// What is saved, as the editor compares against it; undefined for a new skill and for anybody else's.
const stored = computed<SkillDraft | undefined>(() =>
    summary.value?.editable === true && read.value !== undefined
        ? { name: summary.value.name, description: summary.value.description, body: read.value.body }
        : undefined,
);

const draftName = ref(``);
const description = ref(``);
const body = ref(``);
// Bumped to give the editor a fresh start (its "tried to save" state) whenever the text is reset under it.
const revision = ref(0);

const seed = (): void => {
    const held = heldDraft(id);
    const base = held ?? stored.value ?? { name: ``, description: ``, body: `` };
    draftName.value = creating ? (held?.name ?? ``) : base.name;
    description.value = base.description;
    body.value = base.body;
    revision.value += 1;
};

if (creating) {
    seed();
}
// Seeded once, when the saved text first arrives; a later refetch of the same text must not reset what is being typed.
watch(stored, (now, before) => {
    if (now !== undefined && before === undefined) {
        seed();
    }
}, { immediate: true });

// Held while it differs from what is saved, so switching tabs keeps it and a clean page follows the daemon.
watch([draftName, description, body], () => {
    const typed = { name: draftName.value, description: description.value, body: body.value };
    const base = stored.value;
    const dirty = creating
        ? [typed.name, typed.description, typed.body].some((value) => value.trim() !== ``)
        : base !== undefined && (typed.description.trim() !== base.description.trim() || typed.body.trim() !== base.body.trim());
    if (dirty) {
        if (heldDraft(id) === undefined) {
            emit(`edited`);
        }
        holdDraft(id, typed);
    } else {
        dropDraft(id);
    }
});

const saveError = ref<string | undefined>();
const takenNames = computed(() => skills.value.map((entry) => entry.name));

// The daemon decides how the saved skill reads (a new one starts on), so the list and this body are read again before
// the editor stops showing "saving": comparing against the old body would say "not saved yet" for a moment.
const onSave = async (draft: SkillDraft): Promise<void> => {
    saveError.value = undefined;
    try {
        await save.mutateAsync(draft);
        await queryClient.invalidateQueries({ queryKey: rpcKey(`skills.read`, { id: draft.name }) });
    } catch (failure) {
        saveError.value = failure instanceof Error ? failure.message : t(`sandbox.agentSkills.couldntSaveSkill`);
        return;
    }
    dropDraft(id);
    if (creating) {
        emit(`saved`, draft.name);
    }
};

// A rewrite's Cancel puts the saved text back; a new skill's closes it, since there is nothing to go back to.
const onCancel = (): void => {
    dropDraft(id);
    saveError.value = undefined;
    if (creating) {
        emit(`gone`);
        return;
    }
    seed();
};

const onRemove = (): void => {
    if (summary.value === undefined) {
        return;
    }
    remove.mutate(summary.value.name);
    dropDraft(id);
    emit(`gone`);
};

// --- Facts ----------------------------------------------------------------------------------------------------------

const doubt = computed(() => (creating || summary.value === undefined ? undefined : triggerDoubtWords(triggerDoubt(summary.value.description))));

// What a turn that opens it reads, in words: markup alone (a heading's `#`, a list's `-`) is not one.
const words = computed(() => (read.value?.body ?? ``).split(/\s+/u).filter((token) => /[\p{L}\p{N}]/u.test(token)).length);

const used = computed(() => {
    const uses = summary.value?.uses;
    if (uses === undefined) {
        return undefined;
    }
    const last = uses.last === undefined ? undefined : t(`sandbox.skillPage.lastUsed`, { when: timeAgo(Date.parse(uses.last), { days: true }) });
    if (uses.week > 0) {
        return { lead: t(`sandbox.skillPage.turnsThisWeek`, { count: uses.week }, uses.week), last };
    }
    return { lead: uses.last === undefined ? t(`sandbox.skillPage.notUsedYet`) : t(`sandbox.skillPage.notThisWeek`), last };
});

// The connection that ships it, when there is one to manage: the way to drop a skill nobody can switch here.
const connection = computed(() =>
    summary.value?.origin === `capability` && capabilities.value.some((entry) => entry.id === summary.value?.owner) ? summary.value.owner : undefined,
);

// SKILL.md first, then the rest of the folder; openable only where the folder is the workspace's own.
const folder = computed(() => read.value?.folder);
const files = computed(() => (read.value === undefined ? [] : [...(folder.value === undefined ? [] : [`SKILL.md`]), ...read.value.files]));

const openInWorkspace = (file: string): void => {
    if (folder.value !== undefined) {
        emit(`open-file`, `${folder.value}/${file}`);
    }
};

const title = computed(() => (creating ? draftName.value.replace(/-+$/u, ``) : (summary.value?.name ?? name)));

// A fact's label beside its value, as every properties column in the app reads (a Linear or GitHub sidebar).
const LABEL = `text-xs text-subtle pt-0.5`;
</script>

<template>
    <!-- `@container`: the page reflows against its pane, which a split or the docked chat can leave narrow. -->
    <!-- Its own scroller only as a side tab: in a sheet the sheet's body scrolls, and a second one inside it scrolled sideways. -->
    <div class="@container" :class="host === `side` ? `h-full overflow-y-auto` : ``">
        <div class="mx-auto flex max-w-5xl flex-col gap-5" :class="host === `side` ? `px-5 py-4` : ``">
            <header class="flex items-center gap-3">
                <!-- Only a brand: an origin glyph beside the name would say again what the facts column says. -->
                <BrandMark v-if="visual?.logo !== undefined" :size="28" :name="title" :logo="visual.logo" :icon="visual.icon" :idle="summary?.enabled === false" />
                <h1 v-if="host === `side`" class="min-w-0 flex-1 truncate font-mono text-lg font-semibold" :class="summary?.enabled === false ? `text-muted` : `text-content`">
                    <template v-if="title !== ``">{{ title }}</template>
                    <span v-else class="font-sans font-normal text-muted">{{ t(`sandbox.skillForm.newSkill`) }}</span>
                </h1>
                <span v-else class="flex-1" />
                <!-- Said in words beside it: alone on a sheet's first line a bare switch did not say what it switched. -->
                <span v-if="summary?.switchable" class="text-xs text-muted">{{ summary.enabled ? t(`sandbox.skillPage.on`) : t(`sandbox.skillPage.off`) }}</span>
                <ToggleSwitch
                    v-if="summary?.switchable"
                    class="ui-switch-sm shrink-0"
                    :model-value="summary.enabled"
                    :disabled="disabled"
                    :aria-label="t(`sandbox.skillRow.enable`, { name: summary.name })"
                    @update:model-value="(value: boolean) => summary !== undefined && setEnabled(summary, value)"
                />
            </header>

            <Await :of="loaded" :imprint="`sandbox.skill.${id}`" :label="t(`ui.status.reading`)">
                <!-- The detail layout the skill lands in: its properties beside its text once there is room. -->
                <template #fallback>
                    <div role="status" aria-busy="true" :aria-label="t(`ui.status.reading`)" class="flex flex-col gap-6 @3xl:flex-row">
                        <span class="grid shrink-0 grid-cols-[6rem_1fr] content-start gap-x-3 gap-y-3 text-sm @3xl:order-last @3xl:w-72" aria-hidden="true">
                            <template v-for="(width, index) in [`w-24`, `w-16`, `w-32`]" :key="index">
                                <span class="flex min-h-[1lh] items-center"><span class="skeleton block h-2.5 w-12" /></span>
                                <span class="flex min-h-[1lh] items-center"><span class="skeleton block h-3" :class="width" /></span>
                            </template>
                        </span>
                        <span class="flex min-w-0 flex-1 flex-col gap-3" aria-hidden="true">
                            <span class="skeleton block h-5 w-40" />
                            <span v-for="(width, index) in [`w-full`, `w-11/12`, `w-full`, `w-2/3`, `w-5/6`]" :key="index" class="skeleton block h-3" :class="width" />
                        </span>
                    </div>
                </template>
                <template #failed="{ error }">
                    <p class="text-sm text-danger">{{ error }}</p>
                </template>
                <template #default>
                    <!-- Gone since the tab was opened (deleted elsewhere, its connection removed): said, never a blank page. -->
                    <p v-if="!creating && summary === undefined" :class="ui.emptyState()">{{ t(`sandbox.skillPage.gone`, { name }) }}</p>

                    <!-- Properties first on a narrow pane, beside the document once there is room (the app's detail layout). -->
                    <div v-else class="flex flex-col gap-6 @3xl:flex-row">
                        <dl v-if="!creating && summary !== undefined" class="grid shrink-0 grid-cols-[6rem_1fr] content-start gap-x-3 gap-y-3 text-sm @3xl:order-last @3xl:w-72">
                            <template v-if="used !== undefined">
                                <dt :class="LABEL">{{ t(`sandbox.skillPage.used`) }}</dt>
                                <dd class="min-w-0">
                                    <span class="block text-content">{{ used.lead }}</span>
                                    <span v-if="used.last !== undefined" class="block text-xs text-muted">{{ used.last }}</span>
                                </dd>
                            </template>
                            <template v-if="words > 0">
                                <dt :class="LABEL">{{ t(`sandbox.skillPage.size`) }}</dt>
                                <dd class="text-content">{{ t(`sandbox.skillPage.words`, { count: formatCompact(words) }, words) }}</dd>
                            </template>
                            <dt :class="LABEL">{{ t(`sandbox.skillPage.from`) }}</dt>
                            <dd class="min-w-0">
                                <span class="block text-content">{{ provenanceOf(summary) }}</span>
                                <RouterLink v-if="connection !== undefined" :to="here(page.capabilities(connection))" :class="ui.textButton()" class="text-xs">
                                    {{ t(`sandbox.skillPage.openConnection`) }}
                                </RouterLink>
                            </dd>
                            <template v-if="files.length > 0">
                                <dt :class="LABEL">{{ t(`sandbox.skillPage.files`) }}</dt>
                                <dd class="flex min-w-0 flex-col items-start gap-0.5">
                                    <template v-for="file in files" :key="file">
                                        <button
                                            v-if="folder !== undefined"
                                            type="button"
                                            :class="ui.textButton()"
                                            class="max-w-full truncate font-mono text-xs"
                                            v-tooltip.top="`${folder}/${file}`"
                                            @click="openInWorkspace(file)"
                                        >
                                            {{ file }}
                                        </button>
                                        <span v-else class="max-w-full truncate font-mono text-xs text-muted">{{ file }}</span>
                                    </template>
                                </dd>
                            </template>
                            <!-- A dropped file's own delete; the reader's own skill deletes from under its text, where it is written. -->
                            <template v-if="summary.removable && !summary.editable">
                                <dt />
                                <dd><SkillDelete :name="summary.name" :disabled="disabled" @remove="onRemove" /></dd>
                            </template>
                        </dl>

                        <div class="min-w-0 flex-1">
                            <!-- The reader's own, or a new one: written where it is read. -->
                            <SkillEditor
                                v-if="creating || stored !== undefined"
                                :key="revision"
                                v-model:name="draftName"
                                v-model:description="description"
                                v-model:body="body"
                                :skill="stored"
                                :taken="takenNames"
                                :disabled="disabled"
                                :saving="save.isPending.value"
                                :error="saveError"
                                :trigger-note="doubt"
                                @save="onSave"
                                @cancel="onCancel"
                            >
                                <template v-if="summary?.removable" #start>
                                    <SkillDelete :name="summary.name" :disabled="disabled || save.isPending.value" @remove="onRemove" />
                                </template>
                            </SkillEditor>

                            <!-- Somebody else's: the same two facts in the same places, as text. -->
                            <div v-else-if="summary !== undefined && read !== undefined" class="flex flex-col gap-4">
                                <div class="flex flex-col gap-1">
                                    <span class="text-xs text-subtle">{{ t(`sandbox.skillForm.toUse`) }}</span>
                                    <p class="text-sm" :class="summary.description === `` ? `italic text-subtle` : `text-content`">
                                        {{ summary.description === `` ? t(`sandbox.skillRow.noDescriptionAgentRarely`) : summary.description }}
                                    </p>
                                    <p v-if="doubt !== undefined && summary.description !== ``" class="text-xs text-warning">{{ doubt }}</p>
                                </div>
                                <div class="flex flex-col gap-1" style="--prose-measure: 76ch">
                                    <span class="text-xs text-subtle">{{ t(`sandbox.words.instructions`) }}</span>
                                    <!-- Read-only rendering, no Read/Source toggle: Copy hands over the raw file. -->
                                    <MarkdownDocument :model-value="read.body" :label="t(`sandbox.skillRow.instructions`, { name: summary.name })" />
                                </div>
                                <div class="flex">
                                    <CopyButton class="ml-auto" :text="read.body" :label="t(`ui.action.copy`)" v-tooltip.top="t(`sandbox.skillRow.rawFile`)" />
                                </div>
                            </div>
                        </div>
                    </div>
                </template>
            </Await>
        </div>
    </div>
</template>
