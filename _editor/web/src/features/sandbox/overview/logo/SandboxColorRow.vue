<!-- THE SANDBOX'S COLOUR, picked where its name and logo are set (the Overview's identity card), for its owner and Full
     access. One press on a swatch saves it: the rail, the wallpaper and the composer take it for every member as the
     platform answers (useSandboxColor.ts). A preset logo is redrawn in the new colour in the same write, so the
     sandbox never wears two colours at once. -->
<script setup lang="ts">
import { ColorPicker } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { logoStyleImage, readLogoStyle } from "./presets";
import { sandboxColor } from "./sandboxColor";

const t = useT();
const sandbox = useSandbox();
// The swatch just pressed, shown as picked until the platform answers; only the newest press clears it, so a second
// press made while the first is in flight never flickers back to the first.
const pending = ref<string>();
let pressed = 0;
const error = ref<string>();
const current = computed(() => pending.value ?? (sandbox.active.value === undefined ? undefined : sandboxColor(sandbox.active.value)));

const pick = async (color: string): Promise<void> => {
    const row = sandbox.active.value;
    if (row === undefined || color === current.value) {
        return;
    }
    const press = ++pressed;
    pending.value = color;
    error.value = undefined;
    const preset = readLogoStyle(row.image);
    const look = preset === undefined ? { color } : { color, image: logoStyleImage({ ...preset, color }) };
    try {
        await sandbox.update(row.id, look);
    } catch (cause) {
        error.value = messageOr(cause, t(`sandbox.sandboxColor.couldntSave`));
    } finally {
        if (press === pressed) {
            pending.value = undefined;
        }
    }
};
</script>

<template>
    <div v-if="current" data-setting="sandbox-color" class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span class="w-28 shrink-0 text-xs text-subtle">{{ t(`sandbox.sandboxColor.label`) }}</span>
        <ColorPicker :model-value="current" size="sm" :label="t(`sandbox.sandboxColor.label`)" @update:model-value="pick" />
        <p v-if="error" role="alert" class="basis-full text-xs text-danger">{{ error }}</p>
        <p v-else class="basis-full text-xs text-subtle">{{ t(`sandbox.sandboxColor.hint`) }}</p>
    </div>
</template>
