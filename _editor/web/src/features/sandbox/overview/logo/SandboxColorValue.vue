<!-- THE SANDBOX'S COLOUR, the third part of who it is, read on the line under its name ("● Lagoon") as the name and the
     logo are read beside it. For its owner and Full access the value is its own press, as the name is: it opens the
     swatches anchored to it, and one press on a swatch saves (useSandboxColor.ts repaints the rail, the wallpaper and the
     composer for every member as the platform answers). The panel stays open, so the colours can be tried on against
     the rail behind it. A preset logo is redrawn in the new colour in the same write, so the sandbox never wears two
     colours at once. Anyone else reads the colour with nothing to press. -->
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
// The colour in words, the picker's own name for it: sandboxColor() always lands on a swatch.
const named = computed(() => {
    const swatch = SWATCHES.find((entry) => swatchHex(entry) === current.value);
    return swatch === undefined ? `` : t(`ui.colorPicker.${swatch.key}`);
});

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
        <!-- The same transparent rule and inset as the name's own press above it (InlineRename), so the dot sits under
             the name's first letter at rest and the wash lines up with the name's when hovered. -->
        <button
            v-if="editable"
            ref="anchor"
            type="button"
            aria-haspopup="dialog"
            :aria-expanded="open"
            :aria-label="`${t(`sandbox.sandboxColor.title`)}: ${named}`"
            v-tooltip.bottom="open ? undefined : t(`sandbox.sandboxColor.title`)"
            class="group/color touch-target flex h-6 min-w-0 items-center gap-1.5 rounded-md border border-transparent px-1 text-left text-xs text-muted transition-colors hover:bg-overlay hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            :class="open ? `bg-overlay text-content` : ``"
            @click="open = !open"
        >
            <span class="size-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10" :style="{ background: current }" aria-hidden="true" />
            <span class="truncate">{{ named }}</span>
            <Icon name="pencil" class="shrink-0 text-2xs text-subtle opacity-60 transition-opacity group-hover/color:opacity-100" aria-hidden="true" />
        </button>
        <span v-else class="flex h-6 min-w-0 items-center gap-1.5 border border-transparent px-1 text-xs text-muted" v-tooltip.bottom="t(`sandbox.sandboxColor.title`)">
            <span class="size-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10" :style="{ background: current }" aria-hidden="true" />
            <span class="truncate">{{ named }}</span>
        </span>
        <!-- A refusal that came back after the panel closed stays in sight beside the colour it failed to change. -->
        <span v-if="error && !open" role="alert" class="min-w-0 truncate text-xs text-danger">{{ error }}</span>

        <ResponsiveOverlay
            v-if="editable"
            v-model="open"
            :anchor="anchor"
            :header="t(`sandbox.sandboxColor.title`)"
            side="bottom"
            cross="start"
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
