<!-- The passphrase, typed twice: chosen when Passwords is turned on and changed in Settings. What is typed lives in this component alone and goes with it. -->
<script setup lang="ts">
import { Button, ui } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { t } from "../i18n.js";

// The keyring's own floor (MASTER_PASSWORD_MIN in @intentic/keyring), which refuses anything shorter.
const PASSPHRASE_MIN = 10;

const {
    submitLabel,
    busy = false,
    disabled = false,
    cancellable = false,
    help,
} = defineProps<{
    submitLabel: string;
    busy?: boolean;
    disabled?: boolean;
    cancellable?: boolean;
    /** Said under the two fields while nothing is wrong. Absent: how long it must be. */
    help?: string | undefined;
}>();
const emit = defineEmits<{ submit: [passphrase: string]; cancel: [] }>();

const draft = ref(``);
const again = ref(``);
const long = computed(() => [...draft.value].length >= PASSPHRASE_MIN);
const problem = computed(() => {
    if (draft.value.length > 0 && !long.value) {
        return t(`app.passphrase.short`, { count: PASSPHRASE_MIN });
    }
    return again.value.length > 0 && again.value !== draft.value ? t(`app.passphrase.mismatch`) : undefined;
});
const ready = computed(() => long.value && again.value === draft.value);
const submit = (): void => {
    if (ready.value && !busy && !disabled) {
        emit(`submit`, draft.value);
    }
};
</script>

<template>
    <form class="flex w-full max-w-sm flex-col gap-2" @submit.prevent="submit()">
        <input
            v-model="draft"
            type="password"
            autocomplete="new-password"
            :class="ui.input({ size: `sm` })"
            :placeholder="t(`app.passphrase.new`)"
            :aria-label="t(`app.passphrase.new`)"
        />
        <input
            v-model="again"
            type="password"
            autocomplete="new-password"
            :class="ui.input({ size: `sm` })"
            :placeholder="t(`app.passphrase.again`)"
            :aria-label="t(`app.passphrase.again`)"
        />
        <p class="text-left text-2xs" :class="problem ? `text-danger` : `text-subtle`">{{ problem ?? help ?? t(`app.passphrase.length`, { count: PASSPHRASE_MIN }) }}</p>
        <div class="flex justify-end gap-2">
            <button v-if="cancellable" type="button" :class="ui.textButton({ size: `xs`, tone: `quiet` })" @click="emit(`cancel`)">{{ t(`app.cancel`) }}</button>
            <Button type="submit" tier="accent" size="small" :label="submitLabel" :loading="busy" :disabled="!ready || busy || disabled" />
        </div>
    </form>
</template>
