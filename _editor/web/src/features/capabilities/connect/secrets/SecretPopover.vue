<!-- Where one of a secret's settings is changed: a panel hanging off its value on a desktop, a sheet on a phone, with the change's own Save and the daemon's answer. -->
<script setup lang="ts">
import { Button, Notice, type NoticeModel, ResponsiveOverlay } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { nextTick, ref, watch } from "vue";

const t = useT();

const {
    anchor,
    header,
    saving = false,
    error = undefined,
    canSave = true,
    wide = false,
    bare = false,
    focusField = false,
} = defineProps<{
    anchor: HTMLElement | undefined;
    /** What is being changed, as the sheet's title on a phone. */
    header: string;
    saving?: boolean;
    /** Why the last save was refused, in the daemon's words. */
    error?: NoticeModel | undefined;
    canSave?: boolean;
    /** A list editor needs the wider panel; a short choice does not. */
    wide?: boolean;
    /** Content that carries its own way to finish (a value field with its own Save, Type into…): no footer. */
    bare?: boolean;
    /** Opened to type something (a value, a host): the first box takes the cursor, so typing starts at once. */
    focusField?: boolean;
}>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ save: [] }>();

// Immediate too: a closed row's own pencil opens the row and this panel in one press.
const body = ref<HTMLElement>();
watch(
    open,
    async (isOpen) => {
        if (!isOpen || !focusField) {
            return;
        }
        await nextTick();
        body.value?.querySelector<HTMLElement>(`input, textarea`)?.focus();
    },
    { immediate: true },
);
</script>

<template>
    <ResponsiveOverlay v-model="open" :anchor="anchor" :header="header" side="bottom" :panel-class="wide ? `w-pop p-4` : `w-pop-sm p-4`">
        <div ref="body" class="flex flex-col gap-3">
            <slot />
            <Notice v-if="error" :of="error" />
            <div v-if="!bare" class="flex items-center justify-end gap-2 border-t border-line-subtle pt-3">
                <Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" @click="open = false" />
                <Button tier="accent" :label="t(`ui.action.save`)" size="small" :loading="saving" :disabled="!canSave || saving" @click="emit(`save`)" />
            </div>
        </div>
    </ResponsiveOverlay>
</template>
