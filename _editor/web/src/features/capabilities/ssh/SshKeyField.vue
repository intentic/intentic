<!-- An ssh connection's key when the sandbox makes it: the private half stays in the sandbox, so this shows only the
     public half and the one command that authorizes it on the server. The form's answer is a marker naming the key. -->
<script setup lang="ts">
import type { CapabilityField } from "@intentic/extension-manifest";
import { type SshKey, stashedMarker, stashedToken } from "@intentic/sandbox-contract";
import { Button, Code, ui } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { authorizeCommand } from "../model/sshKey";
import { generateSshKey } from "./generateSshKey";

const t = useT();

const { field, values, stored = false, alarm } = defineProps<{
    field: CapabilityField;
    /** The form's live answers: this row writes its own key (the marker), and reads `user` and the echoed `publicKey`. */
    values: Record<string, string>;
    /** The connection being edited already holds a key, which a blank answer keeps. */
    stored?: boolean;
    /** The red treatment, for a submit refused while no key has been made. */
    alarm?: string | undefined;
}>();

const emit = defineEmits<{ left: [] }>();

const made = ref<SshKey>();
const generating = ref(false);
const failure = ref<string>();

// A key made here counts only while the form still holds its marker: a form re-seeded for another connection has let it go.
const fresh = computed(() => (made.value !== undefined && values[field.key] === stashedMarker(made.value.token) ? made.value : undefined));
// The key on screen: one made just now, else the one the connection being edited already signs in with.
const publicKey = computed(() => fresh.value?.publicKey ?? (stored ? values[`publicKey`] : undefined));
const command = computed(() => (publicKey.value === undefined ? `` : authorizeCommand(publicKey.value)));
const authorizeLabel = computed(() => {
    const user = (values[`user`] ?? ``).trim();
    return user === `` ? t(`capabilities.sshKeyField.authorizeAsUserAbove`) : t(`capabilities.sshKeyField.authorizeAs`, { user });
});

const generate = async (): Promise<void> => {
    generating.value = true;
    failure.value = undefined;
    try {
        const key = await generateSshKey();
        made.value = key;
        values[field.key] = stashedMarker(key.token);
        emit(`left`);
    } catch (error) {
        failure.value = messageOr(error, t(`capabilities.sshKeyField.couldntGenerate`));
    } finally {
        generating.value = false;
    }
};

// "Paste my own key" answers the same key: what it held is not a key made here, and a marker is not text to show there.
onMounted(() => {
    values[field.key] = ``;
});
onBeforeUnmount(() => {
    if (stashedToken(values[field.key]) !== undefined) {
        values[field.key] = ``;
    }
});
</script>

<template>
    <!-- A div, not a label: a label forwards every click inside it to its first control, which here generates a key. -->
    <div class="ui-field">
        <span class="ui-field-label">
            {{ field.label }}
            <Icon v-if="publicKey" name="check-circle" class="ml-1 text-2xs text-success" />
        </span>
        <template v-if="publicKey">
            <Code :code="publicKey" :wrap="true" :label="t(`capabilities.sshKeyField.publicKey`)" />
            <Code :code="command" lang="bash" :wrap="true" :label="authorizeLabel" />
            <span v-if="fresh && stored" class="text-2xs text-warning">{{ t(`capabilities.sshKeyField.replacesOldKey`) }}</span>
            <span class="flex flex-wrap items-center gap-x-1.5 text-2xs text-muted">
                {{ t(`capabilities.sshKeyField.privateHalfStays`) }}
                <button type="button" :class="ui.textButton({ size: `xs` })" :disabled="generating" @click.prevent="generate">
                    {{ t(`capabilities.sshKeyField.generateNewKey`) }}
                </button>
            </span>
        </template>
        <div v-else class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Button
                :label="stored ? t(`capabilities.sshKeyField.generateNewKey`) : t(`capabilities.sshKeyField.generateKey`)"
                size="small"
                tier="boring"
                :loading="generating"
                @click="generate"
            >
                <template #icon><Icon name="key" /></template>
            </Button>
            <span class="min-w-0 flex-1 text-2xs text-muted">
                {{ stored ? t(`capabilities.sshKeyField.holdsKey`) : t(`capabilities.sshKeyField.sandboxMakesPair`) }}
            </span>
        </div>
        <!-- One severity-ordered line below the control, like every other field on this form. -->
        <span v-if="failure" class="ui-field-error">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ failure }}
        </span>
        <span v-else-if="alarm && !publicKey" class="ui-field-error">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ t(`capabilities.sshKeyField.generateFirst`) }}
        </span>
    </div>
</template>
