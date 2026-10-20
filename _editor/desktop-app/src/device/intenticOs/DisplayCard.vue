<script setup lang="ts">
import type { IntenticOsDisplay } from "@intentic/sandbox-contract/schemas/intentic-os";
import { Button, Notice, Picker, type PickerOption, SegmentedControl, useNow } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import {
    modeForRate,
    modeForSize,
    percentOf,
    rateKeyOf,
    rateLabelOf,
    recommendedOf,
    resolutionKeyOf,
    resolutionsOf,
    scaleKeyOf,
    scalesFor,
    screenNameOf,
} from "./displayCard";
import { displayChanging, displayError, displays, displayTrial, keepDisplay, setDisplay, undoDisplay } from "./settings";

// THE SCREENS, on This computer when this computer runs Intentic OS with a screen (settings.ts holds them, the app's
// os_settings.rs runs `ic os display`): each by what a person calls it, its resolution and how often it redraws, and how
// big text and apps are drawn on it. A change is on trial: it goes back by itself unless the reader keeps it, since a
// screen that went black cannot be read to undo it.

const t = useT();

const screens = computed(() => displays.value?.outputs ?? []);
const now = useNow(() => displayTrial.value !== undefined);
const secondsLeft = computed(() => (displayTrial.value === undefined ? 0 : Math.max(0, Math.ceil((displayTrial.value.endsAt - now.value) / 1000))));

const nameOf = (display: IntenticOsDisplay, index: number): string => {
    const name = screenNameOf(display);
    if (name.kind === `builtIn`) {
        return t(`desktop.os.display.builtIn`);
    }
    return name.kind === `named` ? name.name : t(`desktop.os.display.numbered`, { number: index + 1 });
};

const sizeOptions = (display: IntenticOsDisplay): PickerOption[] => {
    const recommended = recommendedOf(display);
    return resolutionsOf(display).map((size) => {
        const label = t(`desktop.os.display.size`, { width: size.width, height: size.height });
        return size.key === recommended ? { value: size.key, label, description: t(`desktop.os.display.recommended`) } : { value: size.key, label };
    });
};
const rateOptions = (display: IntenticOsDisplay): PickerOption[] => {
    const current = display.current;
    const size = current === null ? undefined : resolutionsOf(display).find((each) => each.key === resolutionKeyOf(current));
    return (size?.rates ?? []).map((rate) => ({ value: rateKeyOf(rate), label: t(`desktop.os.display.rateValue`, { rate: rateLabelOf(rate) }) }));
};
const scaleOptions = (display: IntenticOsDisplay): readonly PickerOption[] =>
    scalesFor(display.scale).map((scale) => ({ value: String(percentOf(scale)), label: t(`desktop.os.display.percent`, { percent: percentOf(scale) }) }));

const pickSize = (display: IntenticOsDisplay, key: string | undefined): void => {
    const mode = key === undefined ? undefined : modeForSize(display, key);
    if (mode !== undefined && (display.current === null || key !== resolutionKeyOf(display.current))) {
        void setDisplay(display.name, { mode });
    }
};
const pickRate = (display: IntenticOsDisplay, key: string | undefined): void => {
    const mode = key === undefined ? undefined : modeForRate(display, key);
    if (mode !== undefined && (display.current === null || key !== rateKeyOf(display.current.refresh))) {
        void setDisplay(display.name, { mode });
    }
};
const pickScale = (display: IntenticOsDisplay, value: string): void => {
    const scale = scalesFor(display.scale).find((each) => String(percentOf(each)) === value);
    if (scale !== undefined && value !== scaleKeyOf(display.scale)) {
        void setDisplay(display.name, { scale });
    }
};
const held = computed(() => displayChanging.value !== undefined);
</script>

<template>
    <section v-if="screens.length > 0" class="flex flex-col gap-3 rounded-xl border border-line p-4" :aria-busy="held">
        <header class="flex items-start gap-2.5 text-sm">
            <Icon name="screen" class="shrink-0 text-link" />
            <h2 class="min-w-0 flex-1 text-sm leading-tight font-semibold">{{ t(`desktop.os.display.title`, {}, screens.length) }}</h2>
        </header>

        <!-- ON TRIAL: kept at a press, else put back by itself when the time is up. -->
        <Notice v-if="displayTrial" tone="info" icon="screen" class="items-center text-xs">
            <span class="min-w-0 flex-1">{{ t(`desktop.os.display.trial`, { count: secondsLeft }, secondsLeft) }}</span>
            <template #actions>
                <Button size="small" :label="t(`desktop.os.display.keep`)" @click="keepDisplay" />
                <Button size="small" tier="quiet" :label="t(`desktop.os.display.undo`)" @click="undoDisplay" />
            </template>
        </Notice>

        <div v-for="(display, index) in screens" :key="display.name" class="flex flex-col gap-2" :class="index > 0 ? `border-t border-line pt-3` : ``">
            <p class="flex items-center gap-2 text-xs font-medium text-content">
                <span class="min-w-0 flex-1 truncate">{{ nameOf(display, index) }}</span>
                <span v-if="!display.enabled" class="shrink-0 text-2xs font-normal text-subtle">{{ t(`desktop.os.display.off`) }}</span>
                <Icon v-if="displayChanging === display.name" name="spinner" spin class="shrink-0 text-link" />
            </p>
            <template v-if="display.enabled && display.current">
                <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div class="flex min-w-0 flex-col gap-1">
                        <span class="text-2xs text-subtle">{{ t(`desktop.os.display.resolution`) }}</span>
                        <Picker
                            :model-value="resolutionKeyOf(display.current)"
                            :options="sizeOptions(display)"
                            variant="input"
                            :disabled="held"
                            :aria-label="t(`desktop.os.display.resolution`)"
                            :header="t(`desktop.os.display.resolution`)"
                            class="ui-field-sm w-full"
                            @update:model-value="(key) => pickSize(display, key)"
                        />
                    </div>
                    <div v-if="rateOptions(display).length > 1" class="flex min-w-0 flex-col gap-1">
                        <span class="text-2xs text-subtle">{{ t(`desktop.os.display.rate`) }}</span>
                        <Picker
                            :model-value="rateKeyOf(display.current.refresh)"
                            :options="rateOptions(display)"
                            variant="input"
                            :disabled="held"
                            :aria-label="t(`desktop.os.display.rate`)"
                            :header="t(`desktop.os.display.rate`)"
                            class="ui-field-sm w-full"
                            @update:model-value="(key) => pickRate(display, key)"
                        />
                    </div>
                </div>
                <div v-if="display.scale !== null" class="flex flex-wrap items-center gap-2">
                    <span class="text-2xs text-subtle">{{ t(`desktop.os.display.scale`) }}</span>
                    <SegmentedControl
                        v-if="!held"
                        size="xs"
                        :options="scaleOptions(display)"
                        :model-value="String(percentOf(display.scale))"
                        @update:model-value="(value) => pickScale(display, value)"
                    />
                    <span v-else class="text-2xs font-medium text-content">{{ t(`desktop.os.display.percent`, { percent: percentOf(display.scale) }) }}</span>
                </div>
            </template>
        </div>

        <Notice v-if="displayError" tone="warning" class="text-2xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="displayError = undefined">
            <span class="block font-medium">{{ t(`desktop.os.display.didntChange`) }}</span>
            <span class="mt-0.5 block font-mono break-words">{{ displayError }}</span>
        </Notice>
    </section>
</template>
