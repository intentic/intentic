<!-- RENAME ONE CONNECTION.
     A dialog rather than an edit-in-place on the row, because the name is not a caption: it is the handle the
     agent holds this connection by: the skill it loads, the prefix on its tools, the variable its credential
     arrives in, the alias `ssh <name>` resolves. A field that changes all of that under a single click deserves
     a sentence saying so and a button to press, which is exactly what a dialog is.

     WHAT IT PROMISES IS THAT NOTHING IS LOST. The daemon carries the state the old name keyed: a signed-in
     browser profile, a paired computer's enrollment, an extension's checkout, and repoints whatever named it.
     That promise is the whole reason this is a route and not an add-then-remove, so the dialog says it plainly:
     the alternative people would otherwise reach for silently signs accounts out.

     IT REPAIRS WHAT THE ADD FORM REPAIRS, by the same rule (cleanName), so a name typed here behaves exactly as
     one typed there: "Ops Box" becomes `Ops-Box`, said out loud under the field rather than refused. The only
     name left to refuse is one with nothing usable in it. What this cannot know is which kinds refuse a rename
     outright and which names are already taken elsewhere: those are the daemon's answers, and arrive as its
     sentence. -->
<script setup lang="ts">
import { Button, ui, Modal, Notice, type NoticeModel } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { cleanName, nameError } from "../pages/capabilities/form";

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
                    :class="[ui.input(`font-mono`), touched && problem ? `ui-field-input-error` : ``]"
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
                browser stays signed in, a connected computer stays paired, and anything pointing at this connection is updated to follow it.
            </p>
        </form>
        <template #footer>
            <Button label="Cancel" size="small" severity="secondary" text @click="emit(`update:visible`, false)" />
            <Button label="Rename" size="small" :loading="busy" :disabled="problem !== undefined || unchanged" @click="emit(`rename`, renamed)" />
        </template>
    </Modal>
</template>
