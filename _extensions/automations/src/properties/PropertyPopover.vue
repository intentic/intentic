<!-- Where one setting is changed: a panel hanging off its value on a desktop, a sheet on a phone, with the change's own Save and the daemon's answer. -->
<script setup lang="ts">
import { Button, ResponsiveOverlay } from "@intentic/extension-ui";
import { t } from "../i18n.js";

const {
    anchor,
    header,
    saving = false,
    error = undefined,
    canSave = true,
    wide = false,
} = defineProps<{
    anchor: HTMLElement | undefined;
    /** What is being changed, as the sheet's title on a phone. */
    header: string;
    saving?: boolean;
    /** Why the last save was refused, in the daemon's words. */
    error?: string | undefined;
    canSave?: boolean;
    /** A schedule's controls need the wider panel; a short choice does not. */
    wide?: boolean;
}>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ save: [] }>();
</script>

<template>
    <ResponsiveOverlay v-model="open" :anchor="anchor" :header="header" :panel-class="wide ? `w-pop p-4` : `w-pop-sm p-4`">
        <div class="flex flex-col gap-3">
            <slot />
            <p v-if="error" class="text-xs break-words text-danger">{{ error }}</p>
            <div class="flex items-center justify-end gap-2 border-t border-line-subtle pt-3">
                <Button :label="t(`automationRow.cancel`)" size="small" tier="quiet" @click="open = false" />
                <Button tier="accent" :label="t(`automationRow.save`)" size="small" :loading="saving" :disabled="!canSave || saving" @click="emit(`save`)" />
            </div>
        </div>
    </ResponsiveOverlay>
</template>
