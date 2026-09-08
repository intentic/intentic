<script setup lang="ts">
import type { SkillDraft, SkillSummary, SystemPromptMode } from "@intentic/sandbox-contract";
import { DisclosureRow, Icon, MarkdownDocument, Notice, Row, RowGroup, RowNote, SegmentedControl } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import SkillForm from "../agent-settings/skills/SkillForm.vue";
import SkillRow from "../agent-settings/skills/SkillRow.vue";
import { usePersonaKit } from "./usePersonaKit";
import { useDraft } from "../../../lib/useDraft";

// What this persona is told: the prompt and its own skills, one tab since they're one folder and one decision. Skills
// reuse the Skills page's <SkillRow>/<SkillForm>, not a second hand-rolled editor. The mode rides the card's autosave;
// the prompt text commits on its own, so a keystroke never hits the personas file.

const { personaId, mode } = defineProps<{
    /** The saved card's id; always set, since a card is created before it's edited. */
    personaId: string;
    mode: SystemPromptMode | undefined;
}>();
const emit = defineEmits<{ "update:mode": [SystemPromptMode | undefined] }>();

// First option is the default: a persona with nothing set runs on the sandbox's prompt. The other three are the same
// bases the sandbox itself offers.
const MODES = [
    { label: `Sandbox's`, value: `inherit` },
    { label: `Intentic`, value: `intentic` },
    { label: `Claude`, value: `claude` },
    { label: `Its own`, value: `custom` },
] as const;
const picked = computed(() => mode ?? `inherit`);
const setMode = (value: string): void => emit(`update:mode`, value === `inherit` ? undefined : (value as SystemPromptMode));

const PROMPT_MAX = 20000; // The route's own cap; the daemon refuses more.
const { kit, error: kitError, isLoading, savePrompt, saveSkill, removeSkill, readSkill } = usePersonaKit(() => personaId);

// Seeded from storage and updated by other windows' saves, never overwritten by an edit in progress (useDraft).
const prompt = useDraft(() => kit.value.prompt);
const error = ref<string | undefined>(undefined);

const commitPrompt = async (text: string): Promise<void> => {
    error.value = undefined;
    try {
        await savePrompt.mutateAsync(text.trim());
    } catch (err) {
        error.value = noticeFrom(err, `Couldn't save this persona's prompt.`).detail;
    }
};

// One row open at a time, the Skills page's own rule: rendering every body at once costs the sum of their instructions.
// A kit skill is always the owner's, so every row is editable and removable, and none is switchable.
const summaryOf = (skill: { name: string; description: string }): SkillSummary => ({
    id: skill.name,
    name: skill.name,
    description: skill.description,
    origin: `persona`,
    enabled: true,
    // On exactly when its persona is worn, so nothing to switch; editable and removable since the owner wrote it.
    switchable: false,
    editable: true,
    removable: true,
});

// A kit skill belongs to no extension or connection, so its mark falls back to the origin glyph.
const NO_SOURCES = { capabilities: [], extensions: [] };

// Which row is open, and whether the new-skill form is; separate flags since a skill may be named anything.
const openName = ref<string | undefined>(undefined);
const adding = ref(false);
// The open row's text, once fetched; undefined while in flight draws the row's "Reading…" line.
const openBody = ref<string | undefined>(undefined);
const bodyError = ref<string | undefined>(undefined);
const busy = ref(false);

const close = (): void => {
    openName.value = undefined;
    openBody.value = undefined;
    bodyError.value = undefined;
    adding.value = false;
};

// Opens a row and fetches its text, or closes it if already open. Name is set before the await so the row shows it's
// opening rather than ignoring the click.
const toggle = async (name: string): Promise<void> => {
    if (openName.value === name) {
        close();
        return;
    }
    close();
    openName.value = name;
    try {
        openBody.value = ((await readSkill(name)) as { body: string }).body;
    } catch (err) {
        bodyError.value = noticeFrom(err, `Couldn't read that skill.`).detail;
    }
};

const startAdd = (): void => {
    close();
    adding.value = true;
};

const run = async (action: () => Promise<unknown>, whenItFails: string): Promise<void> => {
    error.value = undefined;
    busy.value = true;
    try {
        await action();
        close();
    } catch (err) {
        error.value = noticeFrom(err, whenItFails).detail;
    } finally {
        busy.value = false;
    }
};

const save = (skill: SkillDraft): Promise<void> => run(() => saveSkill.mutateAsync(skill), `Couldn't save that skill.`);
const remove = (name: string): Promise<void> => run(() => removeSkill.mutateAsync(name), `Couldn't remove that skill.`);

// Switching cards closes whatever was open on the last one, since the accordion reuses this component.
watch(
    () => personaId,
    () => {
        close();
        error.value = undefined;
    },
);
</script>

<template>
    <div class="flex flex-col gap-5">
        <div class="flex flex-col gap-3">
            <p class="text-xs text-subtle">
                The instructions a session wearing this card carries, and the skills only its turns can reach. Every other chat in this sandbox is
                unaffected.
            </p>

            <!-- Same three words the sandbox setting uses, plus the one answer only a card can give: follow the sandbox. -->
            <label class="flex flex-wrap items-center justify-between gap-3">
                <span class="flex min-w-0 flex-col">
                    <span class="flex items-center gap-2 text-sm text-content">
                        <Icon name="pencil" class="w-4 shrink-0 text-center text-xs text-subtle" />
                        System prompt
                    </span>
                    <span class="text-xs text-subtle">
                        <template v-if="picked === `custom`">Its own words, replacing the sandbox's prompt on this persona's turns.</template>
                        <template v-else-if="picked === `inherit`">Whatever the sandbox is set to: change it in Agent ▸ Instructions.</template>
                        <template v-else>A built-in prompt, for this persona only.</template>
                    </span>
                </span>
                <SegmentedControl :model-value="picked" :options="MODES" @update:model-value="setMode" />
            </label>

            <!--
                Same surface as the sandbox's own prompt: same three bases, same runtime, same kind of document. `save="explicit"` is the same
                declaration the sandbox prompt and safety policy make, since every turn this card wears reads it.
            -->
            <div v-if="picked === `custom`" class="ui-field-shell max-h-[60dvh] overflow-auto p-3" style="--prose-measure: 72ch">
                <MarkdownDocument
                    v-model="prompt"
                    :editable="!isLoading"
                    :stored="isLoading ? undefined : kit.prompt"
                    :saving="savePrompt.isPending.value"
                    save="explicit"
                    label="This persona's system prompt"
                    :max-chars="PROMPT_MAX"
                    placeholder="Write what this persona is, who it is, what it does, how it answers."
                    class="min-h-48"
                    @save="commitPrompt"
                >
                    <!-- What Custom costs, scoped to this card's turns: it drops what this app tells the assistant about its own panels. -->
                    <template #note>
                        Replaces the whole prompt on this persona's turns, including what this app tells the assistant about its question cards,
                        checklist panel and browser tools. Leave it empty to fall back to the sandbox's.
                    </template>
                </MarkdownDocument>
            </div>
        </div>

        <!--
            Shown regardless of the prompt setting, since a persona's checklist is independent of which prompt it runs. Bordered and divided like a
            row group, since that's what it is.
        -->
        <div class="flex flex-col gap-2">
            <span class="flex items-center gap-2 text-sm text-content">
                <Icon name="book" class="w-4 shrink-0 text-center text-xs text-subtle" />
                Its own skills
            </span>
            <!-- A real <RowGroup>, so the rows inside don't each have to declare their own size; the group sets `compact` once. -->
            <RowGroup>
                <!-- The invitation is a row inside the list, not a paragraph above it, matching the Skills page's shape. -->
                <Row
                    v-if="kit.skills.length === 0 && !adding"
                    icon="book"
                    description="None yet. A skill here is instructions the agent reads only while acting as this persona: a house style, a review checklist, the steps for one job."
                />

                <SkillRow
                    v-for="skill in kit.skills"
                    :key="skill.name"
                    :skill="summaryOf(skill)"
                    :expanded="openName === skill.name"
                    :body="openName === skill.name ? openBody : undefined"
                    :body-error="openName === skill.name ? bodyError : undefined"
                    :sources="NO_SOURCES"
                    :disabled="busy"
                    @toggle="void toggle(skill.name)"
                    @save="save"
                    @remove="remove(skill.name)"
                />

                <!--
                    New skill opens in the same place a written one is read, as an open <DisclosureRow>, the same component its twin on the agent's
                    skills list uses.
                -->
                <DisclosureRow v-if="adding" open body="drawer" icon="plus" title="New skill" @update:open="close">
                    <template #below>
                        <SkillForm :disabled="busy" @save="save" @cancel="close" />
                    </template>
                </DisclosureRow>

                <!-- Hidden while something is open, so only one skill is ever being written or read at a time. -->
                <RowNote v-else-if="openName === undefined" variant="action" label="Write a skill" @click="startAdd" />
            </RowGroup>
        </div>

        <Notice
            v-if="kitError !== undefined"
            :of="{ tone: `danger`, title: `Couldn't read this persona's own prompt and skills.`, detail: kitError }"
        />
        <Notice v-if="error !== undefined" tone="warning" class="text-2xs">{{ error }}</Notice>
    </div>
</template>
