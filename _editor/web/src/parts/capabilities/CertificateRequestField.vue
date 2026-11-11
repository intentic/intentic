<!-- A field declaring `keyRequest`: the sandbox makes the private key and keeps it, so this shows only the certificate
     request to send the issuer (copy or download) and the subject it carries. The form's answer is a marker naming the
     key; the request itself goes in the field the declaration names, drawn here rather than as a box of its own. -->
<script setup lang="ts">
import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";
import type { CertificateRequest } from "@intentic/sandbox-contract/schemas/certificate-request";
import { stashedMarker, stashedToken } from "@intentic/sandbox-contract/schemas/capabilities";
import { Button, Code, type NoticeModel, ui } from "@intentic/ui";
import { messageOr, noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted } from "vue";
import { useOperation } from "../../workbench/operations/operations";
import { certificateRequestInput, keyRequestScope, unansweredSubject } from "../../models/capabilities/keyRequest";
import { generateCertificateRequest } from "../../models/capabilities/generateCertificateRequest";

const t = useT();

const { field, values, entry, connection = `new`, stored = false, alarm } = defineProps<{
    field: CapabilityField;
    /** The tile: which card the key is for, and the subject's fields. */
    entry: CapabilityCatalogEntry;
    /** The connection being edited (`new` while adding one): whose form a key made here belongs to. */
    connection?: string | undefined;
    /** The form's live answers: this row writes its own key (the marker) and the request's field, and reads the subject's. */
    values: Record<string, string>;
    /** The connection being edited already holds a key, which a blank answer keeps. */
    stored?: boolean;
    /** The red treatment, for a submit refused while no key has been made. */
    alarm?: string | undefined;
}>();

const emit = defineEmits<{ left: [] }>();

// THE KEY IS THE FORM'S, NOT THIS ROW'S, as with a generated ssh key (SshKeyField): the request goes to an issuer, so a
// key made here is kept in the operations ledger until the connection is saved with it, and the row drawn again shows
// the same request rather than a button whose press would make one the issuer has never seen.
const keyOp = useOperation<CertificateRequest, { readonly notice: NoticeModel; readonly said: string }>(
    () => `${keyRequestScope(entry.id, connection)}/${field.key}`,
);
const made = keyOp.value;
const generating = keyOp.busy;
const failure = computed(() => keyOp.failure.value?.said);
let showing = true;

const requestField = computed(() => field.keyRequest?.request);
// A key made here counts only while the form still holds its marker: a form re-seeded for another connection let it go.
const fresh = computed(() => (made.value !== undefined && values[field.key] === stashedMarker(made.value.token) ? made.value : undefined));
// The request on screen: one made just now, else the one the connection being edited keeps beside its key.
const request = computed(() => fresh.value?.request ?? (stored && requestField.value !== undefined ? values[requestField.value] || undefined : undefined));
const waitingFor = computed(() => unansweredSubject(entry, field, values));

const generate = async (): Promise<void> => {
    if (generating.value || waitingFor.value.length > 0) {
        return;
    }
    const failed = t(`capabilities.certificateRequestField.couldntGenerate`);
    const input = certificateRequestInput(entry, field, values);
    const ended = await keyOp.run({
        what: t(`capabilities.certificateRequestField.generating`),
        failed: (error) => ({ notice: noticeFrom(error, failed), said: messageOr(error, failed) }),
        quiet: true,
        keep: true,
        task: () => generateCertificateRequest(input),
    });
    if (ended?.state === `done` && ended.value !== undefined && showing) {
        values[field.key] = stashedMarker(ended.value.token);
        if (requestField.value !== undefined) {
            values[requestField.value] = ended.value.request;
        }
        emit(`left`);
    }
};

// Saves the request as the file the issuer's form takes.
const download = (): void => {
    if (request.value === undefined) {
        return;
    }
    const link = document.createElement(`a`);
    link.href = URL.createObjectURL(new Blob([request.value], { type: `application/pkcs10` }));
    link.download = `${connection === `new` ? entry.id : connection}.csr`;
    link.click();
    URL.revokeObjectURL(link.href);
};

// "Paste my own" answers the same key: what it held is not a key made here. A key this form already made is its answer again.
onMounted(() => {
    values[field.key] = made.value === undefined ? `` : stashedMarker(made.value.token);
    if (made.value !== undefined && requestField.value !== undefined) {
        values[requestField.value] = made.value.request;
    }
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
            <Icon v-if="request" name="check-circle" class="ml-1 text-2xs text-success" />
        </span>
        <template v-if="request">
            <Code :code="request" :wrap="true" :label="t(`capabilities.certificateRequestField.request`)" />
            <span v-if="fresh" class="text-2xs text-muted">{{ t(`capabilities.certificateRequestField.subject`, { subject: fresh.subject }) }}</span>
            <span v-if="fresh && stored" class="text-2xs text-warning">{{ t(`capabilities.certificateRequestField.replacesOldKey`) }}</span>
            <span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
                <button type="button" :class="ui.textButton({ size: `xs` })" @click.prevent="download">
                    <Icon name="download" class="text-2xs" />
                    {{ t(`capabilities.certificateRequestField.download`) }}
                </button>
                <span>{{ t(`capabilities.certificateRequestField.keyStays`) }}</span>
                <button type="button" :class="ui.textButton({ size: `xs` })" :disabled="generating || waitingFor.length > 0" @click.prevent="generate">
                    {{ t(`capabilities.certificateRequestField.generateNew`) }}
                </button>
            </span>
        </template>
        <div v-else class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Button
                :label="stored ? t(`capabilities.certificateRequestField.generateNew`) : t(`capabilities.certificateRequestField.generate`)"
                size="small"
                tier="boring"
                :loading="generating"
                :disabled="waitingFor.length > 0"
                @click="generate"
            >
                <template #icon><Icon name="key" /></template>
            </Button>
            <span class="min-w-0 flex-1 text-2xs text-muted">
                {{ stored ? t(`capabilities.certificateRequestField.holdsKey`) : t(`capabilities.certificateRequestField.sandboxMakesKey`) }}
            </span>
        </div>
        <span v-if="failure" class="ui-field-error">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ failure }}
        </span>
        <span v-else-if="waitingFor.length > 0" class="text-2xs text-subtle">
            {{ t(`capabilities.certificateRequestField.fillFirst`, { fields: waitingFor.map((candidate) => candidate.label).join(`, `) }) }}
        </span>
        <span v-else-if="alarm && !request" class="ui-field-error">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ t(`capabilities.certificateRequestField.generateFirst`) }}
        </span>
    </div>
</template>
