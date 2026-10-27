<!-- A new value for a password, set where its dots are read: a panel hanging off them on a desktop, a sheet on a phone,
     with its own Save. The old value is never shown here; it is replaced, and kept in the password's history. -->
<script setup lang="ts">
import { Button, Icon, ResponsiveOverlay, SegmentedControl, ui } from "@intentic/extension-ui";
import { computed, ref, useId, watch } from "vue";
import { t } from "../i18n.js";
import { generatePassword } from "./generate.js";
import type { PasswordItem, PasswordPatch } from "./port.js";

const { item, anchor, saving = false } = defineProps<{
    item: PasswordItem;
    anchor: HTMLElement | undefined;
    /** The write is waiting for the person's yes at the computer. */
    saving?: boolean;
}>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ save: [patch: PasswordPatch] }>();

const id = useId();
const value = ref(``);
const showValue = ref(false);
const kind = ref<`password` | `text`>(item.kind);
// Every opening starts empty and on the password's own kind: a value typed and abandoned is not kept anywhere.
watch(open, (now) => {
    if (now) {
        value.value = ``;
        showValue.value = false;
        kind.value = item.kind;
    }
});

const kindOptions = computed(() => [
    { label: t(`app.edit.kindPassword`), value: `password` as const },
    { label: t(`app.edit.kindText`), value: `text` as const },
]);
const header = computed(() => (kind.value === `text` ? t(`app.detail.newText`) : t(`app.detail.newPassword`)));

const generate = (): void => {
    value.value = generatePassword();
    showValue.value = true;
};

// The kind alone can change without a new value; a new value needs no change of kind.
const patch = computed<PasswordPatch | undefined>(() => {
    const next: { -readonly [K in keyof PasswordPatch]: PasswordPatch[K] } = {};
    if (value.value !== ``) {
        next.value = value.value;
    }
    if (kind.value !== item.kind) {
        next.kind = kind.value;
    }
    return Object.keys(next).length === 0 ? undefined : next;
});
const save = (): void => {
    if (patch.value !== undefined && !saving) {
        emit(`save`, patch.value);
    }
};
</script>

<template>
    <ResponsiveOverlay v-model="open" :anchor="anchor" :header="header" panel-class="w-pop-sm p-4">
        <form class="flex flex-col gap-3" @submit.prevent="save">
            <div class="flex flex-col gap-1">
                <label :for="`${id}-value`" class="text-xs font-medium text-muted">{{ header }}</label>
                <div class="flex gap-2">
                    <input
                        :id="`${id}-value`"
                        v-model="value"
                        :type="showValue ? `text` : `password`"
                        :class="ui.input(`flex-1 font-mono`)"
                        autocomplete="new-password"
                        spellcheck="false"
                    />
                    <button
                        type="button"
                        :class="ui.iconButton({ size: `lg` })"
                        :aria-label="showValue ? t(`app.edit.hide`) : t(`app.edit.show`)"
                        :aria-pressed="showValue"
                        @click="showValue = !showValue"
                    >
                        <Icon :name="showValue ? `eye-slash` : `eye`" />
                    </button>
                </div>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-2">
                <SegmentedControl v-model="kind" :options="kindOptions" size="xs" :aria-label="t(`app.edit.kind`)" />
                <Button tier="boring" size="small" :label="t(`app.edit.generate`)" @click="generate()">
                    <template #icon><Icon name="sparkles" /></template>
                </Button>
            </div>
            <p v-if="saving" class="flex items-center gap-1.5 text-2xs text-info" role="status"><Icon name="spinner" spin />{{ t(`app.confirmHere`) }}</p>
            <div class="flex items-center justify-end gap-2 border-t border-line-subtle pt-3">
                <Button tier="quiet" size="small" :label="t(`app.cancel`)" @click="open = false" />
                <Button tier="accent" size="small" type="submit" :label="t(`app.save`)" :loading="saving" :disabled="patch === undefined || saving" />
            </div>
        </form>
    </ResponsiveOverlay>
</template>
