<!-- RENAME ONE CONNECTION.
     A dialog rather than an edit-in-place on the row, because the name is not a caption: it is the handle the
     agent holds this connection by — the skill it loads, the prefix on its tools, the variable its credential
     arrives in, the alias `ssh <name>` resolves. A field that changes all of that under a single click deserves
     a sentence saying so and a button to press, which is exactly what a dialog is.

     WHAT IT PROMISES IS THAT NOTHING IS LOST. The daemon carries the state the old name keyed — a signed-in
     browser profile, a paired computer's enrollment, an extension's checkout — and repoints whatever named it.
     That promise is the whole reason this is a route and not an add-then-remove, so the dialog says it plainly:
     the alternative people would otherwise reach for silently signs accounts out.

     IT REFUSES WHAT THE ADD FORM REFUSES, in the same words (nameError), so a name that is rejected here would
     have been rejected there. What it cannot know is which kinds refuse a rename outright and which names are
     already taken elsewhere in the sandbox — those are the daemon's answers, and they arrive as its sentence. -->
<script setup lang="ts">
import { cmp, Notice, type NoticeModel } from "@intentic/ui";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import { computed, ref, watch } from "vue";
import { nameError } from "../pages/capabilities/form";

const props = defineProps<{ visible: boolean; id: string; busy?: boolean; error?: NoticeModel | undefined }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "rename", to: string): void }>();

const name = ref(``);
const touched = ref(false);

// Opening seeds the field with the current name and selects it — the common edit is a word changed, not a name
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

const problem = computed(() => nameError(name.value));
const unchanged = computed(() => name.value.trim() === props.id);
</script>

<template>
    <Dialog
        :visible="visible"
        modal
        header="Rename connection"
        :style="{ width: '28rem', maxWidth: '92vw' }"
        @update:visible="emit(`update:visible`, $event)"
    >
        <form class="flex flex-col gap-3" @submit.prevent="!problem && !unchanged && emit(`rename`, name.trim())">
            <Notice v-if="error" :of="error" />
            <label class="ui-field">
                <span class="ui-field-label">Name</span>
                <!-- Autofocused: the dialog exists to change one field, so the caret starts in it. -->
                <input
                    v-model="name"
                    autofocus
                    :class="[cmp.input(`font-mono`), touched && problem ? `ui-field-input-error` : ``]"
                    @blur="touched = true"
                />
                <span v-if="touched && problem" class="ui-field-error">
                    <Icon name="exclamation-triangle" class="text-2xs" />
                    {{ problem }}
                </span>
            </label>
            <p class="text-2xs text-muted">
                This is the name your agent knows the connection by, so its skill and tools are renamed with it. Everything else is kept — a signed-in
                browser stays signed in, a connected computer stays paired, and anything pointing at this connection is updated to follow it.
            </p>
        </form>
        <template #footer>
            <Button label="Cancel" size="small" severity="secondary" text @click="emit(`update:visible`, false)" />
            <Button label="Rename" size="small" :loading="busy" :disabled="problem !== undefined || unchanged" @click="emit(`rename`, name.trim())" />
        </template>
    </Dialog>
</template>
