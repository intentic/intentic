<script setup lang="ts">
import type { SkillDraft, SkillSummary } from "@intentic/sandbox-contract/schemas/settings";
import { Await, Button, Icon, Row, RowGroup, RowNote, SearchBar, SkeletonRows } from "@intentic/ui";
import { computed, ref } from "vue";
import { useCapabilities } from "../../../../models/capabilities/useCapabilities";
import { useExtensions } from "../../../../models/extensions/useExtensions";
import { useSkills } from "../../environment/useSkills";
import SkillDraftRow from "./SkillDraftRow.vue";
import SkillRow from "./SkillRow.vue";
import { bySection, isTunable, matchesSkill } from "./skillList";
import type { SkillSources } from "./skillVisual";
import { useT } from "@intentic/ui/i18n";

// Every skill the agent carries, from any source (image, owner, connections, extensions, plugins, loose files),
// including disabled built-ins and unclaimed files. Split into tunable (this app can enable/delete) and borrowed
// rows; a row's controls come only from what the daemon reports for it, never a rule restated here. Writing a new one is
// the group's own action, top right where every list keeps it ("New setup", "Add another account"), and the skill being
// written appears at the top of the list as the open row it will become.

const t = useT();

const FILTERABLE_FROM = 8;
// Below this many borrowed rows, the fold saves nothing worth a click.
const FOLD_FROM = 6;

const { skills, settings, loaded, save, remove, setEnabled, readBody, forgetBody } = useSkills();
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

// Every name in the list, filtered or not: a new skill saved under one of them would replace it.
const takenNames = computed(() => skills.value.map((skill) => skill.name));

// Which row is open; `adding` is its own flag since a new skill has no id yet.
const openId = ref<string | undefined>();
const adding = ref(false);
// The open row's text, once fetched; its own ref rather than a suspense boundary since the row is already on screen.
const openBody = ref<string | undefined>();
const bodyError = ref<string | undefined>();
// Why the last save failed; the editor stays open with what was typed, and says it beside its Save.
const saveError = ref<string | undefined>();
const saving = computed(() => save.isPending.value);

const close = (): void => {
    openId.value = undefined;
    openBody.value = undefined;
    bodyError.value = undefined;
    saveError.value = undefined;
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
    close();
    openId.value = skill.id;
    try {
        const read = (await readBody(skill.id)).body;
        // A press on another row while this one was still reading has moved on; its answer is not this row's.
        if (openId.value === skill.id) {
            openBody.value = read;
        }
    } catch (failure) {
        if (openId.value === skill.id) {
            bodyError.value = failure instanceof Error ? failure.message : t(`sandbox.agentSkills.couldntReadSkill`);
        }
    }
};

// Closes only once the daemon has it: a refused save keeps the editor and what was typed in it.
const saveDraft = async (draft: SkillDraft): Promise<void> => {
    saveError.value = undefined;
    try {
        await save.mutateAsync(draft);
    } catch (failure) {
        saveError.value = failure instanceof Error ? failure.message : t(`sandbox.agentSkills.couldntSaveSkill`);
        return;
    }
    // Clears the cached body; otherwise reopening the row would show what this edit just replaced.
    forgetBody(draft.name);
    close();
};

const removeSkill = (skill: SkillSummary): void => {
    remove.mutate(skill.name);
    close();
};
</script>

<template>
    <Await :of="loaded" imprint="sandbox.agent.skills" :label="t(`sandbox.agentSkills.readingSandboxsSkills`)">
        <template #fallback>
            <!-- Until it has been seen once: the group as it reads while loading, its action already where it will be. -->
            <RowGroup :label="t(`sandbox.agentSkills.skills`)">
                <template #actions>
                    <Button size="small" tier="boring" :label="t(`sandbox.words.writeSkill`)" disabled>
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>
                <div role="status" aria-busy="true">
                    <span class="sr-only">{{ t(`sandbox.agentSkills.readingSandboxsSkills`) }}</span>
                    <SkeletonRows :rows="3" description control />
                </div>
            </RowGroup>
        </template>
        <template #failed="{ error }">
            <RowGroup :label="t(`sandbox.agentSkills.skills`)">
                <Row icon="exclamation-triangle" :description="error" />
            </RowGroup>
        </template>
        <template #default="{ refreshError }">
            <RowGroup data-setting="agent-skills" :label="t(`sandbox.agentSkills.skills`)">
                <template #actions>
                    <!-- One field beside the one action, not a toolbar: a full bar would look like it belongs to more than this group. -->
                    <SearchBar
                        v-if="filterable"
                        v-model="query"
                        variant="field"
                        clearable
                        :placeholder="t(`sandbox.agentSkills.nameTriggerOrigin`)"
                        :aria-label="t(`sandbox.agentSkills.filterSkills`)"
                        autocapitalize="off"
                        spellcheck="false"
                        class="w-full max-w-56"
                    />
                    <Button size="small" tier="boring" :label="t(`sandbox.words.writeSkill`)" :disabled="settings === undefined" @click="startAdd">
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>

                <!-- First, where the press that made it is: the same head and editor a saved skill opens into. -->
                <SkillDraftRow v-if="adding" :taken="takenNames" :disabled="settings === undefined" :saving="saving" :error="saveError" @save="saveDraft" @cancel="close" />

                <SkillRow
                    v-for="skill in tunable"
                    :key="skill.id"
                    :skill="skill"
                    :expanded="openId === skill.id"
                    :body="openId === skill.id ? openBody : undefined"
                    :body-error="openId === skill.id ? bodyError : undefined"
                    :sources="sources"
                    :disabled="settings === undefined"
                    :saving="openId === skill.id && saving"
                    :save-error="openId === skill.id ? saveError : undefined"
                    @toggle="void toggle(skill)"
                    @enable="(value: boolean) => setEnabled(skill, value)"
                    @save="saveDraft"
                    @remove="removeSkill(skill)"
                />

                <Row v-if="refreshError !== undefined" icon="exclamation-triangle" :description="refreshError" />
                <RowNote v-else-if="skills.length === 0 && !adding" variant="empty">{{ t(`sandbox.agentSkills.noSkillsAddedYet`) }}</RowNote>
                <!-- Distinct from an empty list or from hits hidden inside the closed fold below. -->
                <Row v-else-if="matches.length === 0" icon="search" :description="t(`sandbox.agentSkills.nothingMatchesFilter`)" />

                <!-- Borrowed skills come last, inside the same list rather than a separate section. -->
                <details v-if="borrowed.length > 0" class="group/fold" :open="borrowedOpen" @toggle="rememberFold">
                    <!-- In the rows' own type and inset: a label for the rows under it, not a heading of a size of its own. -->
                    <summary
                        class="ui-row-select flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 [&::-webkit-details-marker]:hidden"
                    >
                        <span class="text-xs font-medium text-muted">{{ t(`sandbox.agentSkills.cameWhatInstalledConnected`, { count: borrowed.length }) }}</span>
                        <!-- Hidden in a narrow pane rather than wrapped, since it's a footnote to the line above, not a second fact. -->
                        <span class="hidden min-w-0 truncate text-2xs text-subtle @xl:inline">{{ t(`sandbox.agentSkills.toDropOneDrop`) }}</span>
                        <Icon
                            name="chevron-right"
                            aria-hidden="true"
                            class="ml-auto shrink-0 text-2xs text-subtle transition-transform group-open/fold:rotate-90"
                        />
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
                            @enable="(value: boolean) => setEnabled(skill, value)"
                            @save="saveDraft"
                            @remove="removeSkill(skill)"
                        />
                    </div>
                </details>
            </RowGroup>
        </template>
    </Await>
</template>
