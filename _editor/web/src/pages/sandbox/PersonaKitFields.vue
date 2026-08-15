<script setup lang="ts">
import type { SystemPromptMode } from "@intentic/sandbox-contract";
import { cmp, Notice, Segmented } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import Button from "primevue/button";
import { computed, ref, watch } from "vue";
import { usePersonaKit } from "../../composables/sandbox/usePersonaKit";
import { useDraft } from "../../composables/useDraft";

/* WHAT THIS PERSONA IS TOLD, AND WHAT IT ALONE KNOWS — the fourth question the card answers, and the one that
 * turns a persona from a label into a working posture.
 *
 * TWO THINGS, ONE SECTION, because they are one folder and one decision: a release-notes writer is a prompt AND
 * the house style it reads, and splitting them across the page would make the second look like an unrelated
 * feature. The daemon keeps both in the card's own kit (`.intentic/personas/<id>/`), laid out so the agent's own
 * loader reads them on the turns wearing this card and no others.
 *
 * IT IS NOT PART OF THE CARD'S AUTOSAVE, and that is the point of it being a separate component with its own
 * store. The rest of the form writes the whole card on a debounce — right for nine switches, wrong for a system
 * prompt, where it would commit every intermediate sentence to a tracked file. So the MODE (a click) rides the
 * card, and the TEXT commits on blur or from a Save button, exactly like the sandbox-wide prompt above it.
 *
 * ONLY FOR A CARD THAT EXISTS. The kit routes answer a missing persona with a 404 deliberately — nothing should
 * be able to mint a persona by writing a file at it — so a card being created says what it will be able to carry
 * rather than offering an editor that would fail on save. */

const { personaId, mode } = defineProps<{
    /** The saved card's id, or undefined while one is being created — see the header. */
    personaId: string | undefined;
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
    if (!promptDirty.value || personaId === undefined) {
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
 * One editor, opened onto whichever skill is being written — a list of textareas would render every skill's
 * instructions at once, and a group of one-line rows should not cost the sum of its bodies to draw.
 *
 * `editing` holds the NAME being edited, "" while a new one is being written. Undefined is the closed state. */
const editing = ref<string | undefined>(undefined);
const form = ref({ name: ``, description: ``, body: `` });
const busy = ref(false);

const openSkill = async (name: string): Promise<void> => {
    error.value = undefined;
    editing.value = name;
    form.value = { name, description: ``, body: `` };
    try {
        const loaded = (await readSkill(name)) as { name: string; description: string; body: string };
        form.value = { name: loaded.name, description: loaded.description, body: loaded.body };
    } catch (err) {
        error.value = noticeFrom(err, `Couldn't read that skill.`).detail;
        editing.value = undefined;
    }
};
const openNew = (): void => {
    error.value = undefined;
    editing.value = ``;
    form.value = { name: ``, description: ``, body: `` };
};

// A skill needs all three parts to be worth saving: the name is the folder the agent finds it by, and the
// description is the only line it reads before deciding whether to open the rest.
const skillValid = computed(
    () => /^[a-z0-9][a-z0-9-]*$/.test(form.value.name) && form.value.description.trim() !== `` && form.value.body.trim() !== ``,
);

const run = async (action: () => Promise<unknown>, whenItFails: string): Promise<void> => {
    error.value = undefined;
    busy.value = true;
    try {
        await action();
        editing.value = undefined;
    } catch (err) {
        error.value = noticeFrom(err, whenItFails).detail;
    } finally {
        busy.value = false;
    }
};

const submitSkill = (): Promise<void> =>
    run(
        () => saveSkill.mutateAsync({ name: form.value.name, description: form.value.description.trim(), body: form.value.body.trim() }),
        `Couldn't save that skill.`,
    );
const dropSkill = (name: string): Promise<void> => run(() => removeSkill.mutateAsync(name), `Couldn't remove that skill.`);

// Switching to a different card closes whatever was open on the last one — the accordion reuses this component,
// and a body left on screen would belong to a persona nobody is looking at.
watch(
    () => personaId,
    () => {
        editing.value = undefined;
        error.value = undefined;
    },
);
</script>

<template>
    <div class="flex flex-col gap-3 border-t border-line pt-4">
        <div class="flex flex-col gap-0.5">
            <span class="ui-field-label">What it is told</span>
            <span class="text-xs text-subtle">
                The instructions a session wearing this card carries, and the skills only its turns can reach. Every other chat in this sandbox is
                unaffected.
            </span>
        </div>

        <!-- The base, as a click. Same three words the sandbox setting uses, plus the one answer only a card can
             give — follow the sandbox, which is what an untouched card means. -->
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
            <Segmented :model-value="picked" :options="MODES" @update:model-value="setMode" />
        </label>

        <!-- A card that has not been created yet cannot carry files: the kit routes refuse a persona that does
             not exist, so that nothing can bring one into being by writing at it. Say so rather than offering an
             editor whose save would fail. -->
        <p v-if="personaId === undefined" class="text-xs text-subtle">Create this persona first, then you can give it a prompt and its own skills.</p>

        <template v-else>
            <template v-if="picked === `custom`">
                <textarea
                    v-model="prompt"
                    rows="5"
                    :maxlength="PROMPT_MAX"
                    :disabled="isLoading"
                    placeholder="Write what this persona is — who it is, what it does, how it answers."
                    :class="cmp.input('w-full resize-y font-mono text-xs')"
                    aria-label="This persona's system prompt"
                    @change="commitPrompt"
                ></textarea>
                <div class="flex items-center justify-between gap-3">
                    <!-- The same cost the sandbox-wide prompt states, scoped to the turns this card actually
                         governs: a replacement drops what this app tells the assistant about its own cards and
                         panels, and a reader who only sees "your text" will not guess that. -->
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

            <!-- Its own skills. Shown whatever the prompt is set to: a persona on the sandbox's prompt can still
                 carry a checklist that only it reads, and those are independent answers. -->
            <div class="flex flex-col gap-2">
                <span class="flex items-center gap-2 text-sm text-content">
                    <Icon name="book" class="w-4 shrink-0 text-center text-xs text-subtle" />
                    Its own skills
                </span>
                <div v-if="kit.skills.length > 0" class="flex flex-col gap-1">
                    <div
                        v-for="skill in kit.skills"
                        :key="skill.name"
                        class="flex items-center justify-between gap-3 rounded-lg border border-line px-2.5 py-1.5"
                    >
                        <span class="flex min-w-0 flex-col">
                            <span class="truncate text-xs font-medium text-content">{{ skill.name }}</span>
                            <span class="truncate text-2xs text-subtle">{{ skill.description }}</span>
                        </span>
                        <span class="flex shrink-0 items-center gap-2">
                            <button type="button" :class="cmp.linkButton('text-2xs text-link')" @click="openSkill(skill.name)">Edit</button>
                            <button
                                type="button"
                                :class="cmp.linkButton('text-2xs text-muted hover:text-danger')"
                                :disabled="busy"
                                @click="dropSkill(skill.name)"
                            >
                                Remove
                            </button>
                        </span>
                    </div>
                </div>
                <p v-else class="text-xs text-subtle">
                    None yet. A skill here is instructions the agent reads only while acting as this persona — a house style, a review checklist, the
                    steps for one job.
                </p>

                <div v-if="editing !== undefined" class="flex flex-col gap-2 rounded-lg border border-line bg-overlay/50 p-2">
                    <input
                        v-model="form.name"
                        :class="cmp.input('w-full text-xs')"
                        :disabled="editing !== ``"
                        placeholder="house-style"
                        aria-label="Skill name"
                    />
                    <input
                        v-model="form.description"
                        :class="cmp.input('w-full text-xs')"
                        placeholder="When to use it — the one line the agent reads before opening the rest."
                        aria-label="When to use this skill"
                    />
                    <textarea
                        v-model="form.body"
                        rows="6"
                        :class="cmp.input('w-full resize-y font-mono text-xs')"
                        placeholder="The instructions themselves."
                        aria-label="Skill instructions"
                    ></textarea>
                    <div class="flex items-center gap-3">
                        <Button label="Save skill" size="small" :loading="busy" :disabled="!skillValid" @click="submitSkill" />
                        <button type="button" :class="cmp.linkButton('text-xs text-muted hover:text-content')" @click="editing = undefined">
                            Cancel
                        </button>
                        <span v-if="!skillValid && form.name !== ``" class="text-2xs text-subtle">
                            A name of lowercase letters, digits and dashes, plus both lines of text.
                        </span>
                    </div>
                </div>
                <button v-else type="button" :class="cmp.linkButton('self-start gap-1 text-xs text-muted hover:text-content')" @click="openNew">
                    <Icon name="plus" class="text-2xs" />
                    Add a skill
                </button>
            </div>

            <Notice
                v-if="kitError !== undefined"
                :of="{ tone: `danger`, title: `Couldn't read this persona's own prompt and skills.`, detail: kitError }"
            />
            <p v-if="error !== undefined" :class="cmp.alertWarning('text-2xs')">{{ error }}</p>
        </template>
    </div>
</template>
