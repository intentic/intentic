<script setup lang="ts">
import { Button, ColorPicker, Modal, SandboxLogo, ui, useTheme } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { LOGO_ICONS, logoStyleImage, readLogoStyle, type LogoStyle } from "./presets";

// Mounted for one sandbox and one editing session. Only Save writes; cancelling drops the draft.
const { name, image, write } = defineProps<{ name: string; image: string | null; write: (image: string) => Promise<void> }>();
const emit = defineEmits<{ close: [] }>();
const t = useT();
const { accent } = useTheme();
const style = ref<LogoStyle>(readLogoStyle(image) ?? { icon: `box`, color: accent.value });
const preview = computed(() => logoStyleImage(style.value));
const icons = computed(() => LOGO_ICONS.map((icon) => ({ icon, label: t(`sandbox.logoStyle.icons.${icon}`) })));
const saving = ref(false);
const error = ref<string>();

const save = async (): Promise<void> => {
    if (saving.value) {
        return;
    }
    saving.value = true;
    error.value = undefined;
    try {
        await write(preview.value);
        emit(`close`);
    } catch (cause) {
        error.value = messageOr(cause, t(`sandbox.sandboxOverview.couldntSaveLogo`));
    } finally {
        saving.value = false;
    }
};
</script>

<template>
    <Modal
        :open="true"
        size="sm"
        :header="t(`sandbox.logoStyle.title`)"
        :dismissable="!saving"
        @update:open="!$event && emit(`close`)"
    >
        <div class="flex flex-col gap-5">
            <div class="flex flex-col items-center gap-2 py-2" role="img" :aria-label="t(`sandbox.logoStyle.preview`)">
                <SandboxLogo :size="80" :image="preview" />
                <span class="max-w-full truncate text-sm text-muted">{{ name }}</span>
            </div>
            <fieldset :disabled="saving" class="min-w-0">
                <legend class="ui-field-label mb-3">{{ t(`sandbox.logoStyle.color`) }}</legend>
                <ColorPicker v-model="style.color" size="sm" :aria-label="t(`sandbox.logoStyle.color`)" />
            </fieldset>
            <fieldset :disabled="saving" class="min-w-0">
                <legend class="ui-field-label mb-2">{{ t(`sandbox.logoStyle.icon`) }}</legend>
                <div class="grid grid-cols-6 justify-items-center gap-2">
                    <button
                        v-for="entry in icons"
                        :key="entry.icon"
                        type="button"
                        :aria-label="entry.label"
                        :aria-pressed="style.icon === entry.icon"
                        v-tooltip.bottom="entry.label"
                        :class="[ui.iconButton({ size: `xl`, on: style.icon === entry.icon }), style.icon === entry.icon ? `ring-1 ring-accent` : ``]"
                        :style="{ color: style.color }"
                        @click="style.icon = entry.icon"
                    >
                        <Icon :name="entry.icon" class="text-xl" />
                    </button>
                </div>
            </fieldset>
            <p v-if="error" role="alert" class="text-sm text-danger">{{ error }}</p>
        </div>
        <template #footer>
            <Button :label="t(`ui.action.cancel`)" tier="quiet" :disabled="saving" @click="emit(`close`)" />
            <Button :label="t(`ui.action.save`)" :loading="saving" :disabled="preview === image" @click="save" />
        </template>
    </Modal>
</template>
