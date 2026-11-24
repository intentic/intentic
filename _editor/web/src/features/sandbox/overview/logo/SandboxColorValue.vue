<!-- THE SANDBOX'S COLOUR, the third part of who it is: one quiet circle beside its name, the colour itself and nothing
     said about it (its name rides the tooltip). For its owner and Full access the circle is its own press, as the name
     and the logo are: it opens the swatches anchored to it, and one press on a swatch saves (useSandboxColor.ts repaints
     the rail, the wallpaper and the composer for every member as the platform answers). The panel stays open, so the
     colours can be tried on against the rail behind it. A preset logo is redrawn in the new colour in the same write,
     so the sandbox never wears two colours at once. Anyone else sees the circle with nothing to press. -->
<script setup lang="ts">
import { ColorPicker, ResponsiveOverlay, SWATCHES, swatchHex } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { logoStyleImage, readLogoStyle } from "./presets";
import { sandboxColor } from "./sandboxColor";

const { editable } = defineProps<{ editable: boolean }>();

const t = useT();
const sandbox = useSandbox();
// The swatch just pressed, shown as picked until the platform answers; only the newest press clears it, so a second
// press made while the first is in flight never flickers back to the first.
const pending = ref<string>();
let pressed = 0;
const error = ref<string>();
const current = computed(() => pending.value ?? (sandbox.active.value === undefined ? undefined : sandboxColor(sandbox.active.value)));
// The colour in words, the picker's own name for it (sandboxColor() always lands on a swatch): for the tooltip and
// for whoever cannot see the circle.
const named = computed(() => {
    const swatch = SWATCHES.find((entry) => swatchHex(entry) === current.value);
    return swatch === undefined ? `` : t(`ui.colorPicker.${swatch.key}`);
});
const tip = computed(() => ({ title: t(`sandbox.sandboxColor.title`), note: named.value }));

const open = ref(false);
const anchor = ref<HTMLElement>();

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
    <span v-if="current" data-setting="sandbox-color" class="flex min-w-0 items-center gap-2">
        <!-- A 12px circle with a hairline edge, so a pale swatch still has a rim on paper. Its press area is the touch
             target's, not its drawn size. Open, it keeps a ring held off it by the card, the picker's own "chosen" mark. -->
        <button
            v-if="editable"
            ref="anchor"
            type="button"
            aria-haspopup="dialog"
            :aria-expanded="open"
            :aria-label="`${t(`sandbox.sandboxColor.title`)}: ${named}`"
            v-tooltip.bottom="open ? undefined : tip"
            class="touch-target size-3 shrink-0 cursor-pointer rounded-full ring-1 ring-inset ring-black/10 transition-shadow hover:ring-2 hover:ring-line-strong hover:ring-offset-2 hover:ring-offset-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            :class="open ? `ring-2 !ring-line-strong ring-offset-2 ring-offset-card` : ``"
            :style="{ background: current }"
            @click="open = !open"
        />
        <span
            v-else
            role="img"
            :aria-label="`${t(`sandbox.sandboxColor.title`)}: ${named}`"
            v-tooltip.bottom="tip"
            class="size-3 shrink-0 rounded-full ring-1 ring-inset ring-black/10"
            :style="{ background: current }"
        />
        <!-- A refusal that came back after the panel closed stays in sight beside the colour it failed to change. -->
        <span v-if="error && !open" role="alert" class="min-w-0 truncate text-xs font-normal text-danger">{{ error }}</span>

        <ResponsiveOverlay
            v-if="editable"
            v-model="open"
            :anchor="anchor"
            :header="t(`sandbox.sandboxColor.title`)"
            side="bottom"
            cross="center"
            panel-class="w-max max-w-pop"
            padded
            titled
        >
            <template #default="{ titleId }">
                <div class="flex flex-col gap-3" data-sandbox-color-editor>
                    <ColorPicker :model-value="current" :label="titleId === undefined ? t(`sandbox.sandboxColor.title`) : undefined" @update:model-value="pick" />
                    <!-- As wide as the swatches above it and no wider: the row of colours sets the panel's width. -->
                    <p v-if="error" role="alert" class="w-0 min-w-full text-xs text-danger">{{ error }}</p>
                    <p v-else class="w-0 min-w-full text-xs leading-relaxed text-muted">{{ t(`sandbox.sandboxColor.hint`) }}</p>
                </div>
            </template>
        </ResponsiveOverlay>
    </span>
</template>
