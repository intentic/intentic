<!--
    Renames one capability connection. A dialog, not an inline edit, since the name is load-bearing (skill id, tool prefix, credential variable, ssh
    alias) and the daemon repoints all of it rather than losing state. Applies the same cleanName rule as the add form.
-->
<script setup lang="ts">
import { Button, ui, Modal, Notice, type NoticeModel } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { cleanName, nameError } from "../model/form";

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
    <Modal :open="visible" size="sm" header="Rename connection" @update:open="emit(`update:visible`, $event)">
        <form class="flex flex-col gap-3" @submit.prevent="!problem && !unchanged && emit(`rename`, renamed)">
            <Notice v-if="error" :of="error" />
            <label class="ui-field">
                <span class="ui-field-label">Name</span>
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
                <!-- The repair, shown rather than performed silently: this line is the contract for what the
                     button will rename to. -->
                <span v-else-if="preview" class="mt-1 flex items-center gap-1 text-2xs text-muted">
                    <Icon name="check" class="text-2xs text-success" />
                    Renamed to <span class="font-mono text-content">{{ preview }}</span>
                </span>
            </label>
            <p class="text-2xs text-muted">
                This is the name your agent knows the connection by, so its skill and tools are renamed with it. Everything else is kept: a signed-in
                browser stays signed in, a connected device stays paired, and anything pointing at this connection is updated to follow it.
            </p>
        </form>
        <template #footer>
            <Button label="Cancel" size="small" severity="secondary" text @click="emit(`update:visible`, false)" />
            <Button label="Rename" size="small" :loading="busy" :disabled="problem !== undefined || unchanged" @click="emit(`rename`, renamed)" />
        </template>
    </Modal>
</template>
