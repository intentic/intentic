<script setup lang="ts">
import { Notice, Picker, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted } from "vue";
import { keyboardNameOf, layoutOf, layoutOptionsOf, STANDARD, variantOptionsOf } from "./keyboardCard";
import { keyboard, keyboardChanging, keyboardError, keyboardLayouts, loadKeyboardLayouts, setKeyboard } from "./settings";

// THE KEYBOARD, on This computer when this computer runs Intentic OS with a screen (settings.ts holds it, the app's
// os_settings.rs runs `ic os keyboard`): the layout in use, every layout to pick from by its name with a box to find one,
// the variants of the one picked, and a line to type into to try it.

const t = useT();

// Every layout the system knows, once per window: read as the card first shows, not on the page's timer.
onMounted(() => void loadKeyboardLayouts());

const name = computed(() => (keyboard.value === undefined ? `` : keyboardNameOf(keyboard.value, keyboardLayouts.value)));
const layouts = computed(() => (keyboardLayouts.value === undefined ? [] : layoutOptionsOf(keyboardLayouts.value)));
const variants = computed(() =>
    keyboard.value === undefined ? [] : variantOptionsOf(layoutOf(keyboardLayouts.value, keyboard.value.layout), t(`desktop.os.keyboard.standard`)),
);

const pickLayout = (layout: string | undefined): void => {
    if (layout !== undefined && layout !== keyboard.value?.layout) {
        void setKeyboard(layout);
    }
};
const pickVariant = (variant: string | undefined): void => {
    const status = keyboard.value;
    if (status !== undefined && variant !== undefined && variant !== (status.variant ?? STANDARD)) {
        void setKeyboard(status.layout, variant === STANDARD ? undefined : variant);
    }
};
</script>

<template>
    <section v-if="keyboard" class="flex flex-col gap-3 rounded-xl border border-line p-4" :aria-busy="keyboardChanging">
        <header class="flex items-start gap-2.5">
            <Icon :name="keyboardChanging ? `spinner` : `globe`" :spin="keyboardChanging" class="mt-0.5 shrink-0 text-link" />
            <div class="min-w-0 flex-1">
                <h2 class="text-sm leading-tight font-semibold">{{ t(`desktop.os.keyboard.title`) }}</h2>
                <p class="mt-1 text-xs text-muted">{{ name }}</p>
            </div>
        </header>

        <div v-if="layouts.length > 0" class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div class="flex min-w-0 flex-col gap-1">
                <span class="text-2xs text-subtle">{{ t(`desktop.os.keyboard.layout`) }}</span>
                <!-- A hundred layouts and more: the picker brings its own box to find one by name. -->
                <Picker
                    :model-value="keyboard.layout"
                    :options="layouts"
                    variant="input"
                    :disabled="keyboardChanging"
                    :search-threshold="0"
                    :aria-label="t(`desktop.os.keyboard.layout`)"
                    :header="t(`desktop.os.keyboard.layout`)"
                    class="ui-field-sm w-full"
                    @update:model-value="pickLayout"
                />
            </div>
            <div v-if="variants.length > 0" class="flex min-w-0 flex-col gap-1">
                <span class="text-2xs text-subtle">{{ t(`desktop.os.keyboard.variant`) }}</span>
                <Picker
                    :model-value="keyboard.variant ?? STANDARD"
                    :options="variants"
                    variant="input"
                    :disabled="keyboardChanging"
                    :aria-label="t(`desktop.os.keyboard.variant`)"
                    :header="t(`desktop.os.keyboard.variant`)"
                    class="ui-field-sm w-full"
                    @update:model-value="pickVariant"
                />
            </div>
        </div>

        <!-- Somewhere to try it: the layout changes for this computer at once, this box included. -->
        <input type="text" autocomplete="off" spellcheck="false" :placeholder="t(`desktop.os.keyboard.tryIt`)" :aria-label="t(`desktop.os.keyboard.tryIt`)" :class="ui.input({ size: `sm` }, `w-full`)" />

        <Notice v-if="keyboardError" tone="warning" class="text-2xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="keyboardError = undefined">
            <span class="block font-medium">{{ t(`desktop.os.keyboard.didntChange`) }}</span>
            <span class="mt-0.5 block font-mono break-words">{{ keyboardError }}</span>
        </Notice>
    </section>
</template>
