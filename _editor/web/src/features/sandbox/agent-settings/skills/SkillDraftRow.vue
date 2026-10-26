<script setup lang="ts">
import type { SkillDraft } from "@intentic/sandbox-contract/schemas/settings";
import { BrandMark, ROW_BLOCK_PAD, Row, useRowDensity } from "@intentic/ui";
import { computed, onMounted, ref } from "vue";
import SkillEditor from "./SkillEditor.vue";
import { skillVisual } from "./skillVisual";
import { useT } from "@intentic/ui/i18n";

// A skill not saved yet, drawn as the open row it will become: the same head and the editor under one rule, at the top
// of the list where the header's "Write a skill" put it. Not a <DisclosureRow>: it has nothing to fold, and a stray
// press on its head must not close it and throw away what was typed. The head is a preview, not a field: it reads "New
// skill" until a name is typed into the form below, then that name, with the mark that name will carry, so what is
// being made is visible before it exists. Every blank to fill is in the form, labelled, in the order it is asked.

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
const named = computed(() => name.value.replace(/-+$/, ``) !== ``);

// Asked of the same tiers a saved row is, as one of the reader's own: no extension or connection can claim it yet.
const visual = computed(() =>
    skillVisual(
        { id: name.value, name: name.value, description: ``, origin: `own`, enabled: true, switchable: true, editable: true, removable: true },
        { capabilities: [], extensions: [] },
    ),
);

const editor = ref<{ focus: (field: `name` | `description` | `body`) => void }>();

// Opens on its name: pressing "Write a skill" already said what comes next.
onMounted(() => {
    if (!disabled) {
        editor.value?.focus(`name`);
    }
});
</script>

<template>
    <div data-skill-draft>
        <Row>
            <template #lead="{ mark }">
                <BrandMark :size="mark" :name="named ? name : `+`" :logo="visual.logo" :icon="named ? visual.icon : `plus`" />
            </template>
            <template #title>
                <span v-if="named" class="font-mono">{{ name }}</span>
                <span v-else class="text-muted">{{ t(`sandbox.skillForm.newSkill`) }}</span>
            </template>
            <template #meta>{{ t(`sandbox.skillWords.own`) }}</template>
        </Row>
        <div class="border-t border-line-subtle" :class="ROW_BLOCK_PAD[tier]">
            <SkillEditor
                ref="editor"
                v-model:name="name"
                :taken="taken"
                :disabled="disabled"
                :saving="saving"
                :error="error"
                @save="emit(`save`, $event)"
                @cancel="emit(`cancel`)"
            />
        </div>
    </div>
</template>
