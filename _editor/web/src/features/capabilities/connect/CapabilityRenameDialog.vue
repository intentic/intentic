<!-- Renames one capability connection. -->
<script setup lang="ts">
import { Button, ui, Modal, Notice, type NoticeModel } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { cleanName, nameError } from "../model/form";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const props = defineProps<{ visible: boolean; id: string; busy?: boolean; error?: NoticeModel | undefined }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "rename", to: string): void }>();

const name = ref(``);
const touched = ref(false);

// Opening seeds the field with the current name and selects it: the common edit is a word changed, not a name
// typed from nothing.
watch(
    () => props.visible,
    (visible) => {
        if (visible) {
            name.value = props.id;
            touched.value = false;
        }
    },
    // Immediate, so a dialog that is mounted already open starts with the name in it rather than empty.
    { immediate: true },
);

// The name this will actually rename to, and the line that says so while it differs from what was typed.
const renamed = computed(() => cleanName(name.value));
const preview = computed(() => (renamed.value !== `` && renamed.value !== name.value.trim() ? renamed.value : undefined));
const problem = computed(() => nameError(name.value));
const unchanged = computed(() => renamed.value === props.id);
</script>

<template>
    <Modal
        :open="visible"
        size="sm"
        :header="t(`capabilities.capabilityRenameDialog.renameConnection`)"
        @update:open="emit(`update:visible`, $event)"
    >
        <form class="flex flex-col gap-3" @submit.prevent="!problem && !unchanged && emit(`rename`, renamed)">
            <Notice v-if="error" :of="error" />
            <label class="ui-field">
                <span class="ui-field-label">{{ t(`capabilities.capabilityRenameDialog.name`) }}</span>
                <!-- Autofocused: the dialog exists to change one field, so the caret starts in it. -->
                <input
                    v-model="name"
                    autofocus
                    :class="[ui.input(`font-mono`), touched && problem ? `ui-field-error-box` : ``]"
                    @blur="touched = true"
                />
                <span v-if="touched && problem" class="ui-field-error">
                    <Icon name="exclamation-triangle" class="text-2xs" />
                    {{ problem }}
                </span>
                <!-- The preview states the exact name the button will apply. -->
                <span v-else-if="preview" class="mt-1 flex items-center gap-1 text-2xs text-muted">
                    <Icon name="check" class="text-2xs text-success" />
                    {{ t(`capabilities.capabilityRenameDialog.renamedTo`) }} <span class="font-mono text-content">{{ preview }}</span>
                </span>
            </label>
            <p class="text-2xs text-muted">
                {{ t(`capabilities.capabilityRenameDialog.nameAgentKnowsConnection`) }}
            </p>
        </form>
        <template #footer>
            <Button :label="t(`ui.action.cancel`)" size="small" severity="secondary" text @click="emit(`update:visible`, false)" />
            <Button
                :label="t(`ui.action.rename`)"
                size="small"
                :loading="busy"
                :disabled="problem !== undefined || unchanged"
                @click="emit(`rename`, renamed)"
            />
        </template>
    </Modal>
</template>
