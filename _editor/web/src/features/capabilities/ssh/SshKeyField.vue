<!-- An ssh connection's key when the sandbox makes it: the private half stays in the sandbox, so this shows only the
     public half and the one command that authorizes it on the server. The form's answer is a marker naming the key. -->
<script setup lang="ts">
import type { CapabilityField } from "@intentic/extension-manifest";
import { type SshKey, stashedMarker, stashedToken } from "@intentic/sandbox-contract";
import { Button, Code, type NoticeModel, ui } from "@intentic/ui";
import { messageOr, noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted } from "vue";
import { useOperation } from "../../../workbench/operations/operations";
import { authorizeCommand, sshKeyScope } from "../model/sshKey";
import { generateSshKey } from "./generateSshKey";

const t = useT();

const { field, values, stored = false, alarm, entry, connection = `new` } = defineProps<{
    field: CapabilityField;
    /** The tile, and the connection being edited (`new` while adding one): whose form a key made here belongs to. */
    entry: string;
    connection?: string | undefined;
    /** The form's live answers: this row writes its own key (the marker), and reads `user` and the echoed `publicKey`. */
    values: Record<string, string>;
    /** The connection being edited already holds a key, which a blank answer keeps. */
    stored?: boolean;
    /** The red treatment, for a submit refused while no key has been made. */
    alarm?: string | undefined;
}>();

const emit = defineEmits<{ left: [] }>();

// THE KEY IS THE FORM'S, NOT THIS ROW'S. The owner copies its public half onto a server, so a key made here is kept in
// the operations ledger until the connection is saved with it (capabilitySubmit puts it away then): the row drawn again
// (Paste my own key and back, another view and back, a key that arrived after the reader left) shows the same key,
// rather than a Generate button whose press would make one the server has never seen.
// Failures are the client's sentence, as the row says it: the app's own words when the sandbox gave none.
const keyOp = useOperation<SshKey, { readonly notice: NoticeModel; readonly said: string }>(() => `${sshKeyScope(entry, connection)}/${field.key}`);
const made = keyOp.value;
const generating = keyOp.busy;
const failure = computed(() => keyOp.failure.value?.said);
let showing = true;

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
    if (generating.value) {
        return;
    }
    const failed = t(`capabilities.sshKeyField.couldntGenerate`);
    const ended = await keyOp.run({
        what: t(`capabilities.sshKeyField.generating`),
        failed: (error) => ({ notice: noticeFrom(error, failed), said: messageOr(error, failed) }),
        // The row shows the key wherever it is drawn next; nothing to say elsewhere.
        quiet: true,
        keep: true,
        task: () => generateSshKey(),
    });
    if (ended?.state === `done` && ended.value !== undefined && showing) {
        values[field.key] = stashedMarker(ended.value.token);
        emit(`left`);
    }
};

// "Paste my own key" answers the same key: what it held is not a key made here, and a marker is not text to show there.
// A key this form already made is its answer again.
onMounted(() => {
    values[field.key] = made.value === undefined ? `` : stashedMarker(made.value.token);
});
onBeforeUnmount(() => {
    showing = false;
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
