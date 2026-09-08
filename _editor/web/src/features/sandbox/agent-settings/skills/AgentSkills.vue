<script setup lang="ts">
import type { SkillDraft, SkillSummary } from "@intentic/api-contract";
import { DisclosureRow, Row, RowGroup, RowNote, SearchBar, SkeletonRows } from "@intentic/ui";
import { computed, ref } from "vue";
import { useCapabilities } from "../../../capabilities/connect/useCapabilities";
import { useExtensions } from "../../../extensions/useExtensions";
import { useSandboxOutline } from "../../overview/useSandboxOutline";
import { useSkills } from "../../environment/useSkills";
import SkillForm from "./SkillForm.vue";
import SkillRow from "./SkillRow.vue";
import SkillsInfo from "./SkillsInfo.vue";
import { bySection, isTunable, matchesSkill } from "./skillList";
import type { SkillSources } from "./skillVisual";

// Every skill the agent carries, from any source (image, owner, connections, extensions, plugins, loose files),
// including disabled built-ins and unclaimed files. Split into tunable (this app can enable/delete) and borrowed
// rows; a row's controls come only from what the daemon reports for it, never a rule restated here.

const FILTERABLE_FROM = 8;
// Below this many borrowed rows, the fold saves nothing worth a click.
const FOLD_FROM = 6;

const { skills, settings, error, save, remove, setEnabled, readBody, forgetBody } = useSkills();
const outline = useSandboxOutline(computed(() => settings.value === undefined));
const { capabilities } = useCapabilities();
const { enabled: enabledExtensions } = useExtensions();

const query = ref(``);
const filtering = computed(() => query.value.trim() !== ``);
const filterable = computed(() => skills.value.length >= FILTERABLE_FROM);
const matches = computed<SkillSummary[]>(() => {
    const needle = query.value.trim().toLowerCase();
    return skills.value.filter((skill) => matchesSkill(skill, needle)).toSorted(bySection);
});

// The two halves of the list: what this surface can act on, and what merely arrived with something.
const tunable = computed(() => matches.value.filter(isTunable));
const borrowed = computed(() => matches.value.filter((skill) => !isTunable(skill)));

// Opens automatically while small or while filtering; a manual toggle is remembered otherwise, so clearing the
// search doesn't refold it.
const openedByHand = ref<boolean | undefined>(undefined);
const borrowedOpen = computed(() => filtering.value || (openedByHand.value ?? borrowed.value.length <= FOLD_FROM));
const rememberFold = (event: Event): void => {
    if (!filtering.value) {
        openedByHand.value = (event.target as HTMLDetailsElement).open;
    }
};

// Enabled, not installed: a disabled extension doesn't claim the card its connection came from.
const sources = computed<SkillSources>(() => ({ capabilities: capabilities.value, extensions: enabledExtensions.value }));

// Which row is open; `adding` is its own flag since a new skill has no id yet.
const openId = ref<string | undefined>();
const adding = ref(false);
// The open row's text, once fetched; its own ref rather than a suspense boundary since the row is already on screen.
const openBody = ref<string | undefined>();
const bodyError = ref<string | undefined>();

const close = (): void => {
    openId.value = undefined;
    openBody.value = undefined;
    bodyError.value = undefined;
    adding.value = false;
};

const startAdd = (): void => {
    close();
    adding.value = true;
};

// Opens a row and fetches its body, or closes it if already open. id is set before the await so the row shows it's
// opening immediately.
const toggle = async (skill: SkillSummary): Promise<void> => {
    if (openId.value === skill.id) {
        close();
        return;
    }
    adding.value = false;
    openId.value = skill.id;
    openBody.value = undefined;
    bodyError.value = undefined;
    try {
        openBody.value = (await readBody(skill.id)).body;
    } catch (failure) {
        bodyError.value = failure instanceof Error ? failure.message : `Couldn't read this skill.`;
    }
};

const saveDraft = (draft: SkillDraft): void => {
    // Clears the cached body; otherwise reopening the row would show what this edit just replaced.
    forgetBody(draft.name);
    save.mutate(draft);
    close();
};

const removeSkill = (skill: SkillSummary): void => {
    remove.mutate(skill.name);
    close();
};

// Counts what's currently shown; a stale total over a filtered list can't be trusted.
const count = computed<number | undefined>(() => (filtering.value ? matches.value.length : skills.value.length || undefined));
</script>

<template>
    <RowGroup label="Skills" :count="count">
        <template #info><SkillsInfo /></template>
        <!-- One field, not a toolbar: a full bar for a single control would look like it belongs to more than this group. -->
        <template v-if="filterable" #actions>
            <SearchBar
                v-model="query"
                variant="field"
                clearable
                placeholder="Name, trigger or origin…"
                aria-label="Filter skills"
                autocapitalize="off"
                spellcheck="false"
                class="w-full max-w-64 sm:w-64"
            />
        </template>

        <SkillRow
            v-for="skill in tunable"
            :key="skill.id"
            :skill="skill"
            :expanded="openId === skill.id"
            :body="openId === skill.id ? openBody : undefined"
            :body-error="openId === skill.id ? bodyError : undefined"
            :sources="sources"
            :disabled="settings === undefined"
            @toggle="void toggle(skill)"
            @enable="(value: boolean) => setEnabled(skill.name, value)"
            @save="saveDraft"
            @remove="removeSkill(skill)"
        />

        <Row v-if="error !== undefined" icon="exclamation-triangle" :description="error" />
        <!-- No settings yet means no skills to show and no grounds to say the list is empty; shows a loading state instead. -->
        <div v-else-if="settings === undefined" role="status" aria-busy="true">
            <template v-if="outline">
                <span class="sr-only">Reading this sandbox's skills…</span>
                <SkeletonRows :rows="3" description control />
            </template>
        </div>
        <Row v-else-if="skills.length === 0 && !adding" icon="book" description="No skills added yet." />
        <!-- Distinct from an empty list or from hits hidden inside the closed fold below. -->
        <Row v-else-if="matches.length === 0" icon="search" description="Nothing matches that filter." />

        <!-- Adding uses the same row surface a written skill is read on. -->
        <!-- Padding and tint values mirror <DisclosureRow>'s own; keep them in sync if that component's spacing changes. -->
        <DisclosureRow v-if="adding" open body="drawer" icon="plus" title="New skill" @update:open="close">
            <template #below>
                <SkillForm :disabled="settings === undefined" @save="saveDraft" @cancel="close" />
            </template>
        </DisclosureRow>

        <!--
            Hidden while a row is open, so only one skill is written or read at a time. RowNote reads its position and
            size from <DisclosureRow>'s own chevron, so it stays aligned if that moves.
        -->
        <RowNote v-else-if="openId === undefined" variant="action" label="Write a skill" @click="startAdd" />

        <!-- Borrowed skills come last, inside the same list rather than a separate section. -->
        <details v-if="borrowed.length > 0" class="group/fold" :open="borrowedOpen" @toggle="rememberFold">
            <summary
                class="flex cursor-pointer list-none items-center gap-2.5 py-2.5 pl-2.5 pr-3 transition-colors hover:bg-content/4 [&::-webkit-details-marker]:hidden"
            >
                <Icon name="chevron-right" aria-hidden="true" class="shrink-0 text-2xs text-subtle transition-transform group-open/fold:rotate-90" />
                <span class="text-sm text-muted">{{ borrowed.length }} came with what you installed and connected</span>
                <!-- Hidden on narrow screens rather than wrapped, since it's a footnote to the line above, not a second fact. -->
                <span class="hidden min-w-0 truncate text-2xs text-subtle sm:inline">to drop one, drop the thing that ships it</span>
            </summary>
            <div class="divide-y divide-line-subtle border-t border-line-subtle">
                <SkillRow
                    v-for="skill in borrowed"
                    :key="skill.id"
                    :skill="skill"
                    :expanded="openId === skill.id"
                    :body="openId === skill.id ? openBody : undefined"
                    :body-error="openId === skill.id ? bodyError : undefined"
                    :sources="sources"
                    :disabled="settings === undefined"
                    @toggle="void toggle(skill)"
                    @enable="(value: boolean) => setEnabled(skill.name, value)"
                    @save="saveDraft"
                    @remove="removeSkill(skill)"
                />
            </div>
        </details>
    </RowGroup>
</template>
