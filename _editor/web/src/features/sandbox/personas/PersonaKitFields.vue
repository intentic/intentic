<script setup lang="ts">
import { type SkillDraft, type SkillSummary, SYSTEM_PROMPT_MAX, type SystemPromptMode } from "@intentic/sandbox-contract/schemas/settings";
import { Button, Icon, MarkdownDocument, Notice, RowGroup, RowNote, SegmentedControl } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import SkillDraftRow from "../agent-settings/skills/SkillDraftRow.vue";
import SkillRow from "../agent-settings/skills/SkillRow.vue";
import { usePersonaKit } from "./usePersonaKit";
import { useTrimmedDraft } from "../../../lib/useDraft";
import { useT } from "@intentic/ui/i18n";

// What this persona is told: the prompt and its own skills, one tab since they're one folder and one decision. Skills
// reuse the Skills page's <SkillRow>/<SkillDraftRow>, not a second hand-rolled editor. The mode rides the persona's autosave;
// the prompt text commits on its own, so a keystroke never hits the personas file.

const t = useT();

const { personaId, mode } = defineProps<{
    /** The saved persona's id; always set, since a persona is created before it's edited. */
    personaId: string;
    mode: SystemPromptMode | undefined;
}>();
const emit = defineEmits<{ "update:mode": [SystemPromptMode | undefined] }>();

// First option is the default: a persona with nothing set runs on the sandbox's prompt. The other three are the same
// bases the sandbox itself offers.
const MODES = computed(
    () =>
        [
            { label: t(`sandbox.personaKitFields.sandboxs`), value: `inherit` },
            { label: `Intentic`, value: `intentic` },
            { label: `Claude`, value: `claude` },
            { label: t(`sandbox.personaKitFields.own`), value: `custom` },
        ] as const,
);
const picked = computed(() => mode ?? `inherit`);
const setMode = (value: string): void => emit(`update:mode`, value === `inherit` ? undefined : (value as SystemPromptMode));

const { kit, error: kitError, isLoading, savePrompt, saveSkill, removeSkill, readSkill } = usePersonaKit(() => personaId);

// Seeded from storage and updated by other windows' saves, never overwritten by an edit in progress. Saved trimmed, so
// measured trimmed (useTrimmedDraft), or a save that landed would still read "Not saved yet".
const { draft: prompt, stored: storedPrompt } = useTrimmedDraft(() => (isLoading.value ? undefined : kit.value.prompt));
const error = ref<string | undefined>(undefined);

const commitPrompt = async (text: string): Promise<void> => {
    error.value = undefined;
    try {
        await savePrompt.mutateAsync(text.trim());
    } catch (err) {
        error.value = noticeFrom(err, t(`sandbox.personaKitFields.couldntSavePrompt`)).detail;
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
// Why the last save failed, said beside the editor's Save, which stays open with what was typed.
const saveError = ref<string | undefined>(undefined);

const close = (): void => {
    openName.value = undefined;
    openBody.value = undefined;
    bodyError.value = undefined;
    saveError.value = undefined;
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
        openBody.value = (await readSkill(name)).body;
    } catch (err) {
        bodyError.value = noticeFrom(err, t(`sandbox.personaKitFields.couldntReadSkill`)).detail;
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

const save = async (skill: SkillDraft): Promise<void> => {
    saveError.value = undefined;
    busy.value = true;
    try {
        await saveSkill.mutateAsync(skill);
        close();
    } catch (err) {
        saveError.value = noticeFrom(err, t(`sandbox.personaKitFields.couldntSaveSkill`)).detail;
    } finally {
        busy.value = false;
    }
};
const remove = (name: string): Promise<void> => run(() => removeSkill.mutateAsync(name), t(`sandbox.personaKitFields.couldntRemoveSkill`));

// Switching personas closes whatever was open on the last one, since the accordion reuses this component.
watch(
    () => personaId,
    () => {
        close();
        error.value = undefined;
    },
);
</script>

<template>
    <div class="flex flex-col gap-6">
        <div class="flex flex-col gap-3">
            <p class="text-xs text-subtle">
                {{ t(`sandbox.personaKitFields.instructionsSessionOnPersona`) }}
            </p>

            <!-- Same three words the sandbox setting uses, plus the one answer only a persona can give: follow the sandbox. -->
            <label class="flex flex-wrap items-center justify-between gap-3">
                <span class="flex min-w-0 flex-col">
                    <span class="flex items-center gap-2 text-sm text-content">
                        <Icon name="pencil" class="w-4 shrink-0 text-center text-xs text-subtle" />
                        {{ t(`sandbox.words.systemPrompt`) }}
                    </span>
                    <span class="text-xs text-subtle">
                        <template v-if="picked === `custom`">{{ t(`sandbox.personaKitFields.ownWordsReplacingSandboxs`) }}</template>
                        <template v-else-if="picked === `inherit`">{{ t(`sandbox.personaKitFields.whateverSandboxSetTo`) }}</template>
                        <template v-else>{{ t(`sandbox.personaKitFields.builtInPromptPersona`) }}</template>
                    </span>
                </span>
                <SegmentedControl :model-value="picked" :options="MODES" @update:model-value="setMode" />
            </label>

            <!-- Same surface as the sandbox's own prompt: same three bases, same runtime, same kind of document. The
                 unlabelled group is the one surface it stands on — a document never wears a field frame. -->
            <RowGroup v-if="picked === `custom`">
                <MarkdownDocument
                    v-model="prompt"
                    frame="section"
                    :editable="!isLoading"
                    :stored="storedPrompt"
                    :saving="savePrompt.isPending.value"
                    save="explicit"
                    :label="t(`sandbox.personaKitFields.personasSystemPrompt`)"
                    :max-chars="SYSTEM_PROMPT_MAX"
                    :placeholder="t(`sandbox.personaKitFields.writeWhatPersonaWho`)"
                    @save="commitPrompt"
                >
                    <!-- Custom mode removes the app's built-in briefing for this persona. -->
                    <template #note>
                        {{ t(`sandbox.personaKitFields.replacesWholePromptOn`) }}
                    </template>
                </MarkdownDocument>
            </RowGroup>
        </div>

        <!-- Shown regardless of the prompt setting, since a persona's checklist is independent of which prompt it runs. Writing
             one is the list's own action, top right, as on the Skills page. -->
        <RowGroup :label="t(`sandbox.personaKitFields.ownSkills`)">
            <template #actions>
                <Button size="small" tier="boring" :label="t(`sandbox.words.writeSkill`)" :disabled="busy" @click="startAdd">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </template>

            <SkillDraftRow
                v-if="adding"
                :taken="kit.skills.map((skill) => skill.name)"
                :disabled="busy"
                :saving="busy"
                :error="saveError"
                @save="save"
                @cancel="close"
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
                :saving="openName === skill.name && busy"
                :save-error="openName === skill.name ? saveError : undefined"
                @toggle="void toggle(skill.name)"
                @save="save"
                @remove="remove(skill.name)"
            />

            <RowNote v-if="kit.skills.length === 0 && !adding" variant="empty">{{ t(`sandbox.personaKitFields.noneYetSkillHere`) }}</RowNote>
        </RowGroup>

        <Notice
            v-if="kitError !== undefined"
            :of="{ tone: `danger`, title: t(`sandbox.personaKitFields.couldntReadKit`), detail: kitError }"
        />
        <Notice v-if="error !== undefined" tone="warning" class="text-2xs">{{ error }}</Notice>
    </div>
</template>
