<script setup lang="ts">
import { cmp, Notice } from "@intentic/ui";
import Button from "primevue/button";
import { computed, ref } from "vue";
import { devFillGet } from "../composables/devFill";
import { useCapabilitySecret } from "../composables/extensions/useCapabilities";
import { useSecrets } from "../composables/secrets/useSecrets";
import { useAsyncAction } from "../composables/useAsyncAction";

/* The one way a secret value enters the app: a masked input with an eye toggle that writes KEY=value straight
 * to the sandbox daemon's .env (never the platform), plus the shared provenance line. Used by the Sandbox Secrets tab
 * and every credential form (Cloudflare/GitHub/GitLab/Stripe), so the wording and behavior stay identical.
 * `collect` mode skips the write and only emits the value — for flows that need the raw value first (e.g.
 * Cloudflare zone discovery) and write it themselves. */

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
        // Show a Cancel button beside Save that emits `cancel` — for editors that open in place.
        cancellable?: boolean;
        // Externally block saving (e.g. the add-secret row gates Save on a valid key typed alongside).
        disabled?: boolean;
    }>(),
    { placeholder: undefined, multiline: false, collect: false, noHint: false, capabilityId: undefined, cancellable: false, disabled: false },
);

const value = defineModel<string>({ default: `` });
const emit = defineEmits<{ saved: []; cancel: [] }>();

// Dev autofill (inert in prod): offer the last value saved under this key — mount-only and only when empty, so
// the post-save clear stays cleared and collect-mode callers receive the prefill through v-model.
if (value.value === ``) {
    const remembered = devFillGet(`secret.${props.secretKey}`);
    if (remembered !== undefined) {
        value.value = remembered;
    }
}

const { set } = useSecrets();
const setCapabilitySecret = useCapabilitySecret();
const show = ref(false);
const { busy: saving, notice, run } = useAsyncAction();
const canSave = computed(() => !props.disabled && value.value.trim().length > 0);

const save = async (): Promise<void> => {
    if (!canSave.value || props.collect) {
        return;
    }
    await run(async () => {
        if (props.capabilityId !== undefined) {
            await setCapabilitySecret.mutateAsync({ id: props.capabilityId, value: value.value.trim() });
        } else {
            await set.mutateAsync({ key: props.secretKey, value: value.value.trim() });
        }
        value.value = ``;
        emit(`saved`);
    }, `Could not save the secret.`);
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
    <div class="flex flex-col gap-1.5">
        <div class="flex items-start gap-2">
            <textarea
                v-if="multiline"
                v-model="value"
                rows="4"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                :placeholder="placeholder ?? `Paste the value for ${secretKey}`"
                :class="[cmp.input('flex-1 resize-y font-mono text-xs'), show ? '' : 'blur-[3px] focus:blur-none']"
            ></textarea>
            <input
                v-else
                v-model="value"
                :type="show ? 'text' : 'password'"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                :placeholder="placeholder ?? `Paste the value for ${secretKey}`"
                :class="cmp.input('flex-1')"
                @keydown.enter="onEnter"
            />
            <Button severity="secondary" :text="true" :aria-label="show ? 'Hide value' : 'Show value'" @click="show = !show">
                <template #icon><Icon :name="show ? 'eye-slash' : 'eye'" /></template>
            </Button>
            <Button v-if="!collect" label="Save" :disabled="!canSave" :loading="saving" @click="save">
                <template #icon><Icon name="check" /></template>
            </Button>
            <Button v-if="cancellable" severity="secondary" :text="true" aria-label="Cancel" @click="emit(`cancel`)">
                <template #icon><Icon name="times" /></template>
            </Button>
        </div>
        <Notice v-if="notice" :of="notice" />
        <p v-else-if="!noHint" class="text-xs text-muted">
            Stored in your sandbox's <span class="font-mono">.env</span> as <span class="font-mono">{{ secretKey }}</span> — never on the platform.
        </p>
    </div>
</template>
