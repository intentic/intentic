<script setup lang="ts">
import { Button, ui, Notice } from "@intentic/ui";
import { computed, getCurrentInstance, onBeforeUnmount, ref } from "vue";
import { useOperation } from "../../workbench/operations/operations";
import { devFillGet } from "../../app/devFill";
import { useCapabilitySecret } from "../../models/capabilities/useCapabilities";
import { useSecrets } from "../../models/capabilities/useSecrets";
import { useT } from "@intentic/ui/i18n";

// The one way a secret value enters the app: masked input + eye toggle, writing KEY=value to the sandbox daemon's
// .env (never the platform), with a shared provenance line, used by every credential form so wording stays
// identical. `collect` mode skips the write and only emits the value, for a caller that writes it itself.

const t = useT();

const props = withDefaults(
    defineProps<{
        secretKey: string;
        placeholder?: string;
        // Multi-line values (SSH keys, PEM blocks) get a textarea instead of a password input.
        multiline?: boolean;
        // collect: don't write to the sandbox; just emit the value through v-model (the caller writes it).
        collect?: boolean;
        // Hide the provenance line (when the surrounding form already explains where the value goes).
        noHint?: boolean;
        // Set = the value replaces this capability's secret (POST /capabilities/{id}/secret) instead of .env.
        capabilityId?: string;
        // Show a Cancel button beside Save that emits `cancel`: for editors that open in place.
        cancellable?: boolean;
        // Externally block saving (e.g. the add-secret row gates Save on a valid key typed alongside).
        disabled?: boolean;
    }>(),
    { placeholder: undefined, multiline: false, collect: false, noHint: false, capabilityId: undefined, cancellable: false, disabled: false },
);

const value = defineModel<string>({ default: `` });
const emit = defineEmits<{ saved: []; cancel: [] }>();

// Dev autofill (inert in prod): fills the last value saved under this key, mount-only and only when empty.
if (value.value === ``) {
    const remembered = devFillGet(`secret.${props.secretKey}`);
    if (remembered !== undefined) {
        value.value = remembered;
    }
}

const { set } = useSecrets();
const setCapabilitySecret = useCapabilitySecret();
const show = ref(false);
// The write is the secret's, in the operations ledger: a field drawn again mid-write finds its Save still held, and one
// drawn after a refusal still says why. The value itself stays in this field and goes nowhere else.
const write = useOperation(() => `secrets/${props.capabilityId ?? `env`}/${props.secretKey}`);
const saving = write.busy;
const notice = write.failure;
const canSave = computed(() => !props.disabled && value.value.trim().length > 0);
let showing = getCurrentInstance() !== null;
onBeforeUnmount(() => {
    showing = false;
});

const save = async (): Promise<void> => {
    if (!canSave.value || props.collect || saving.value) {
        return;
    }
    const given = value.value.trim();
    const { capabilityId, secretKey } = props;
    write.dismiss();
    const ended = await write.run({
        what: t(`capabilities.secretField.saving`, { secretKey }),
        failed: t(`capabilities.secretField.couldNotSave`),
        task: async () => {
            if (capabilityId !== undefined) {
                await setCapabilitySecret.mutateAsync({ id: capabilityId, value: given });
            } else {
                await set.mutateAsync({ key: secretKey, value: given });
            }
        },
    });
    if (ended?.state === `done` && showing) {
        value.value = ``;
        emit(`saved`);
    }
};

// In collect mode Enter falls through to the surrounding form's submit; standalone, it saves directly.
const onEnter = (event: KeyboardEvent): void => {
    if (props.collect) {
        return;
    }
    event.preventDefault();
    void save();
};
</script>

<template>
    <div class="flex min-w-0 flex-col gap-1.5">
        <div class="flex min-w-0 flex-wrap items-start gap-2">
            <textarea
                v-if="multiline"
                v-model="value"
                rows="4"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                :placeholder="placeholder ?? t(`capabilities.secretField.pasteValue`, { secretKey })"
                :aria-label="placeholder ?? t(`capabilities.secretField.pasteValue`, { secretKey })"
                :class="[ui.input({ size: `sm` }, 'min-w-0 flex-1 basis-40 resize-y font-mono'), show ? '' : 'blur-mask focus:blur-none']"
            ></textarea>
            <input
                v-else
                v-model="value"
                :type="show ? 'text' : 'password'"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                :placeholder="placeholder ?? t(`capabilities.secretField.pasteValue`, { secretKey })"
                :aria-label="placeholder ?? t(`capabilities.secretField.pasteValue`, { secretKey })"
                :class="ui.input('min-w-0 flex-1 basis-40')"
                @keydown.enter="onEnter"
            />
            <div class="flex max-w-full flex-wrap items-center gap-2">
                <Button
                    tier="quiet"
                    :aria-label="show ? t(`capabilities.words.hideValue`) : t(`capabilities.secretField.showValue`)"
                    @click="show = !show"
                >
                    <template #icon><Icon :name="show ? 'eye-slash' : 'eye'" /></template>
                </Button>
                <Button v-if="!collect" :label="t(`ui.action.save`)" :disabled="!canSave" :loading="saving" @click="save">
                    <template #icon><Icon name="check" /></template>
                </Button>
                <Button v-if="cancellable" tier="quiet" :aria-label="t(`ui.action.cancel`)" @click="emit(`cancel`)">
                    <template #icon><Icon name="times" /></template>
                </Button>
            </div>
        </div>
        <Notice v-if="notice" :of="notice" />
        <p v-else-if="!noHint" class="text-xs text-muted">
            {{ t(`capabilities.secretField.storedInSandboxs`) }} <span class="font-mono">.env</span> {{ t(`capabilities.secretField.as`) }}
            <span class="font-mono">{{ secretKey }}</span
            >{{ t(`views.words.neverOnPlatform`) }}
        </p>
    </div>
</template>
