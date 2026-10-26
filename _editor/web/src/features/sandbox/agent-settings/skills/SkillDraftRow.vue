<script setup lang="ts">
import type { SkillDraft } from "@intentic/sandbox-contract/schemas/settings";
import { BrandMark, Icon, ROW_BLOCK_PAD, Row, useRowDensity } from "@intentic/ui";
import { computed, onMounted, ref, useId } from "vue";
import SkillEditor from "./SkillEditor.vue";
import { skillVisual } from "./skillVisual";
import { useT } from "@intentic/ui/i18n";

// A skill not saved yet, drawn as the open row it will become: the same head and the same editor under one rule, at the
// top of the list where the header's "Write a skill" put it. Not a <DisclosureRow>: it has nothing to fold, and a stray
// press on its head must not close it and throw away what was typed, so it leaves the open row's wash to the rows that do. It is named in its head, where its
// name will stand, and the mark beside it follows the name as it is typed, so what is being made is visible before it
// exists.

const t = useT();

const {
    taken,
    disabled = false,
    saving = false,
    error,
} = defineProps<{
    taken: readonly string[];
    disabled?: boolean;
    saving?: boolean;
    error?: string | undefined;
}>();
const emit = defineEmits<{ save: [SkillDraft]; cancel: [] }>();

const tier = useRowDensity(() => undefined);

const name = ref(``);
// Restricts to what a slug can hold (the name becomes a directory), enforced while typing rather than on save.
const onName = (event: Event): void => {
    // SAFETY: bound only on the name <input> below, so the event's target is that input.
    const box = event.target as HTMLInputElement;
    const slug = box.value.toLowerCase().replace(/[^a-z0-9-]/g, `-`);
    box.value = slug;
    name.value = slug;
};

// Asked of the same tiers a saved row is, as one of the reader's own: no extension or connection can claim it yet.
const visual = computed(() =>
    skillVisual(
        { id: name.value, name: name.value, description: ``, origin: `own`, enabled: true, switchable: true, editable: true, removable: true },
        { capabilities: [], extensions: [] },
    ),
);

const editor = ref<{ focus: (field: `description`) => void; nameProblem: string | undefined }>();
const problem = computed(() => editor.value?.nameProblem);

const nameBox = ref<HTMLInputElement>();
const hintId = useId();
const problemId = useId();

// Opens on its name: pressing "Write a skill" already said what comes next.
onMounted(() => {
    if (!disabled) {
        nameBox.value?.focus();
    }
});
</script>

<template>
    <div data-skill-draft>
        <Row>
            <template #lead="{ mark }">
                <BrandMark :size="mark" :name="name === `` ? `+` : name" :logo="visual.logo" :icon="name === `` ? `plus` : visual.icon" />
            </template>
            <!-- The title's own type, so the name reads as the title it becomes; pulled out by its padding so it starts
                 where every other row's title does. -->
            <template #title>
                <input
                    ref="nameBox"
                    :value="name"
                    type="text"
                    :aria-label="t(`shared.name`)"
                    :placeholder="t(`sandbox.skillForm.forExample`, { example: `release-notes` })"
                    spellcheck="false"
                    autocapitalize="off"
                    autocorrect="off"
                    autocomplete="off"
                    :aria-describedby="problem === undefined ? hintId : `${hintId} ${problemId}`"
                    :aria-invalid="problem !== undefined"
                    :disabled="disabled"
                    class="field-bare ui-field-lit -mx-1.5 -my-0.5 w-full max-w-80 rounded-md px-1.5 py-0.5 font-medium transition-colors hover:bg-content/5 max-md:text-base"
                    @input="onName"
                    @keydown.enter.exact.prevent="editor?.focus(`description`)"
                />
            </template>
            <template #description>
                <span v-if="problem !== undefined" :id="problemId" class="flex items-center gap-1.5 text-danger">
                    <Icon name="exclamation-circle" class="shrink-0 text-2xs" aria-hidden="true" />
                    {{ problem }}
                </span>
                <span :id="hintId" :class="problem === undefined ? `` : `sr-only`">{{ t(`sandbox.skillForm.lowercaseLettersNumbersDashes`) }}</span>
            </template>
            <template #meta>{{ t(`sandbox.skillWords.own`) }}</template>
        </Row>
        <div class="border-t border-line-subtle" :class="ROW_BLOCK_PAD[tier]">
            <SkillEditor
                ref="editor"
                :name="name"
                :taken="taken"
                :disabled="disabled"
                :saving="saving"
                :error="error"
                @save="emit(`save`, $event)"
                @cancel="emit(`cancel`)"
                @focus-name="nameBox?.focus()"
            />
        </div>
    </div>
</template>
