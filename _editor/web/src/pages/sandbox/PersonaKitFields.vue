<script setup lang="ts">
import type { SkillDraft, SkillSummary, SystemPromptMode } from "@intentic/sandbox-contract";
import { Icon, Notice, Row, SegmentedControl, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import Button from "primevue/button";
import { computed, ref, watch } from "vue";
import SkillForm from "./agent/SkillForm.vue";
import SkillRow from "./agent/SkillRow.vue";
import { usePersonaKit } from "../../composables/sandbox/usePersonaKit";
import { useDraft } from "../../composables/useDraft";

/* WHAT THIS PERSONA IS TOLD, AND WHAT IT ALONE KNOWS — the third of the card's questions, and the one that turns
 * a persona from a label into a working posture.
 *
 * TWO THINGS, ONE TAB, because they are one folder and one decision: a release-notes writer is a prompt AND the
 * house style it reads, and splitting them across the card would make the second look like an unrelated feature.
 * The daemon keeps both in the card's own kit (`.intentic/config/personas/<id>/`), laid out so the agent's own loader
 * reads them on the turns wearing this card and no others.
 *
 * THE SKILLS ARE THE SKILLS PAGE'S OWN ROWS AND ITS OWN EDITOR, and that is the whole of why this file is short.
 * They were hand-rolled here first — a text link to add one, three bare inputs to write it — which put a second,
 * worse way to write a skill two clicks from the real one: no markdown editor, no preview, no "why is the button
 * grey", a different delete, a different everything. A skill is a skill wherever it is kept, so <SkillRow> and
 * <SkillForm> render these exactly as Agent ▸ Skills renders the sandbox's, and the row that adds one is the
 * same full-width `+` row that list uses rather than a link nothing else in the app has.
 *
 * WHAT THE ROWS ARE HANDED is a summary built here rather than one the daemon sends, because these skills are
 * not in that inventory's shape: a kit skill has no switch (it is on exactly when its persona is worn) and no
 * owner to name (the card it sits on is three lines up). Everything else — the mark, the chip, the open-in-place
 * reading, the confirm before delete — comes free with the row.
 *
 * IT IS NOT PART OF THE CARD'S AUTOSAVE, and that is the point of it being a separate component with its own
 * store. The rest of the form writes the whole card on a debounce — right for nine switches, wrong for a system
 * prompt, where it would commit every intermediate sentence to a tracked file. So the MODE (a click) rides the
 * card, and the TEXT commits on blur or from a Save button, exactly like the sandbox-wide prompt it stands in
 * for. */

const { personaId, mode } = defineProps<{
    /** The saved card's id. A card is created before it is edited, so there is always one. */
    personaId: string;
    mode: SystemPromptMode | undefined;
}>();
const emit = defineEmits<{ "update:mode": [SystemPromptMode | undefined] }>();

/* Four options, and the first is the default: a persona that says nothing about the prompt runs on the sandbox's,
 * which is what every card meant before this field existed. The other three are the same bases the sandbox
 * chooses between — the same three words, deliberately, because they mean the same three things. */
const MODES = [
    { label: `Sandbox's`, value: `inherit` },
    { label: `Intentic`, value: `intentic` },
    { label: `Claude`, value: `claude` },
    { label: `Its own`, value: `custom` },
] as const;
const picked = computed(() => mode ?? `inherit`);
const setMode = (value: string): void => emit(`update:mode`, value === `inherit` ? undefined : (value as SystemPromptMode));

const PROMPT_MAX = 20000; // The route's own cap — the daemon refuses more.
const { kit, error: kitError, isLoading, savePrompt, saveSkill, removeSkill, readSkill } = usePersonaKit(() => personaId);

// Seeded from what is stored and followed across other windows' saves, never over an edit here (useDraft).
const prompt = useDraft(() => kit.value.prompt);
const promptDirty = computed(() => prompt.value !== kit.value.prompt);
const error = ref<string | undefined>(undefined);

const commitPrompt = async (): Promise<void> => {
    prompt.value = prompt.value.trim();
    if (!promptDirty.value) {
        return;
    }
    error.value = undefined;
    try {
        await savePrompt.mutateAsync(prompt.value);
    } catch (err) {
        error.value = noticeFrom(err, `Couldn't save this persona's prompt.`).detail;
    }
};

/* ── Its own skills ──────────────────────────────────────────────────────────────────────────────────────────
 *
 * One row per skill, one of them open at a time — the Skills page's rule, for its reason: a list that renders
 * every body at once costs the sum of its instructions to draw, and a card is not the place to discover that.
 *
 * A KIT SKILL IS ALWAYS THE OWNER'S, which is what makes these rows simpler than that page's. There is nothing
 * here that arrived with an extension or a plugin, so every row is editable and removable and none is
 * switchable — and <SkillRow> opens an editable skill straight into the form, so reading and editing are the
 * same click. */
const summaryOf = (skill: { name: string; description: string }): SkillSummary => ({
    id: skill.name,
    name: skill.name,
    description: skill.description,
    origin: `persona`,
    enabled: true,
    // On exactly when its persona is worn, so there is nothing here to switch; the owner's to rewrite and to
    // delete, because they wrote it.
    switchable: false,
    editable: true,
    removable: true,
});

// The rows need what the marks are drawn from. A kit skill belongs to no extension and no connection, so it
// falls to its origin glyph — and asking for those lists would be two cached reads to answer "nothing".
const NO_SOURCES = { capabilities: [], extensions: [] };

// Which row is open, by name, and whether the new-skill form is. Separate flags rather than a sentinel name,
// for the reason the skills list keeps them separate: a skill may be called anything.
const openName = ref<string | undefined>(undefined);
const adding = ref(false);
// The open row's text, once it has arrived — its own ref, because a body is a fetch and the row is already on
// screen. Undefined while it is in flight, which is what draws the row's "Reading…" line.
const openBody = ref<string | undefined>(undefined);
const bodyError = ref<string | undefined>(undefined);
const busy = ref(false);

const close = (): void => {
    openName.value = undefined;
    openBody.value = undefined;
    bodyError.value = undefined;
    adding.value = false;
};

// Open a row and fetch its text — or close it if it is the one already open. The name is set BEFORE the await so
// the row shows it is opening rather than appearing to ignore the click for a round trip.
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

// Switching to a different card closes whatever was open on the last one — the accordion reuses this component,
// and a body left on screen would belong to a persona nobody is looking at.
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

            <!-- The base, as a click. Same three words the sandbox setting uses, plus the one answer only a card
                 can give — follow the sandbox, which is what an untouched card means. -->
            <label class="flex flex-wrap items-center justify-between gap-3">
                <span class="flex min-w-0 flex-col">
                    <span class="flex items-center gap-2 text-sm text-content">
                        <Icon name="pencil" class="w-4 shrink-0 text-center text-xs text-subtle" />
                        System prompt
                    </span>
                    <span class="text-xs text-subtle">
                        <template v-if="picked === `custom`">Its own words, replacing the sandbox's prompt on this persona's turns.</template>
                        <template v-else-if="picked === `inherit`">Whatever the sandbox is set to — change it in Agent ▸ Instructions.</template>
                        <template v-else>A built-in prompt, for this persona only.</template>
                    </span>
                </span>
                <SegmentedControl :model-value="picked" :options="MODES" @update:model-value="setMode" />
            </label>

            <template v-if="picked === `custom`">
                <textarea
                    v-model="prompt"
                    rows="5"
                    :maxlength="PROMPT_MAX"
                    :disabled="isLoading"
                    placeholder="Write what this persona is — who it is, what it does, how it answers."
                    :class="ui.input('w-full resize-y font-mono text-xs')"
                    aria-label="This persona's system prompt"
                    @change="commitPrompt"
                ></textarea>
                <div class="flex items-center justify-between gap-3">
                    <!-- What Custom costs, scoped to the turns this card governs: a replacement drops what this
                         app tells the assistant about its own cards and panels, and a reader who only sees "your
                         text" will not guess that. -->
                    <span class="text-2xs text-subtle">
                        Replaces the whole prompt on this persona's turns, including what this app tells the assistant about its question cards,
                        checklist panel and browser tools. Leave it empty to fall back to the sandbox's.
                    </span>
                    <!-- Blur already saves; the button is for the reader who cannot tell that it did.
                         `mousedown.prevent` keeps focus in the textarea so pressing it does not unmount the
                         button out from under the click that was landing on it. -->
                    <Button
                        v-if="promptDirty"
                        label="Save"
                        size="small"
                        class="shrink-0"
                        :loading="savePrompt.isPending.value"
                        @mousedown.prevent
                        @click="commitPrompt"
                    />
                </div>
            </template>
        </div>

        <!-- ITS OWN SKILLS, as the Skills page draws them. Shown whatever the prompt is set to: a persona on the
             sandbox's prompt can still carry a checklist that only it reads, and those are independent answers.

             Bordered and divided like a row group, because that is what it is — a small list inside a card. -->
        <div class="flex flex-col gap-2">
            <span class="flex items-center gap-2 text-sm text-content">
                <Icon name="book" class="w-4 shrink-0 text-center text-xs text-subtle" />
                Its own skills
            </span>
            <div class="divide-y divide-line overflow-hidden rounded-lg border border-line">
                <!-- The invitation is a ROW inside the list, not a line above it — the Skills page's shape. Above
                     it, an empty list said the same thing twice: a paragraph explaining there is nothing, and a
                     bordered box holding nothing but the button that would fix it. -->
                <Row
                    v-if="kit.skills.length === 0 && !adding"
                    icon="book"
                    density="compact"
                    description="None yet. A skill here is instructions the agent reads only while acting as this persona — a house style, a review checklist, the steps for one job."
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

                <!-- The new skill is written in the same place a written one is read, so the form is never a
                     different screen from the list it joins — the Skills page's own arrangement. -->
                <div v-if="adding" class="bg-content/6">
                    <div class="flex items-center gap-2.5 py-2.5 pl-2.5 pr-3">
                        <Icon name="plus" class="shrink-0 text-2xs text-subtle" aria-hidden="true" />
                        <span class="text-sm font-medium text-content">New skill</span>
                    </div>
                    <div class="border-t border-line py-3 pl-9 pr-3">
                        <SkillForm :disabled="busy" @save="save" @cancel="close" />
                    </div>
                </div>

                <!-- Hidden while something is open, so there is only ever one skill being written or read.
                     Hand-written rather than <Row>: every tier of the shared row pads to px-4, which pushed the
                     plus a step right of the chevron column the rows above are hung on. This is the "New skill"
                     header before it is clicked, so opening the form reads as the row unfolding. -->
                <button
                    v-else-if="openName === undefined"
                    type="button"
                    class="group flex w-full cursor-pointer items-center gap-2.5 py-2.5 pl-2.5 pr-3 text-left transition-colors hover:bg-content/4"
                    @click="startAdd"
                >
                    <Icon name="plus" aria-hidden="true" class="shrink-0 text-2xs text-subtle" />
                    <span class="text-sm text-muted transition-colors group-hover:text-content">Write a skill</span>
                </button>
            </div>
        </div>

        <Notice
            v-if="kitError !== undefined"
            :of="{ tone: `danger`, title: `Couldn't read this persona's own prompt and skills.`, detail: kitError }"
        />
        <Notice v-if="error !== undefined" tone="warning" class="text-2xs">{{ error }}</Notice>
    </div>
</template>
