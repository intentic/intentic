<script setup lang="ts">
import { Button, InfoHint, Picker, RowGroup, RowNote, type Tip, toneDot } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { EngineMode, EngineStatus } from "../../desktopEngine";
import { modeMeaning, modeOptions, nowOf, nowPress, nowWords, othersKeepWsl, startupSwitchedOff } from "./background";

// RUNS IN THE BACKGROUND, on This computer under its masthead (BackgroundSection.vue hands it the store): when Intentic's
// engine runs, which is the one setting a person needs to stop VmmemWSL coming back at every sign-in (2026-11-24), what
// it is doing now with a press to stop or start it, and Windows' own Startup apps switch when it says the opposite of the
// setting. A column of label and value pairs on the group's card; the value of the setting is the press that changes it.

const t = useT();

const props = defineProps<{
    /** When the engine runs, as ic stored it. */
    mode: EngineMode;
    status: EngineStatus;
    /** Whether anything answers where the engine listens, as the page last looked. */
    listening: boolean | undefined;
    /** The app is starting it from the page's Docker card or notice. */
    starting: boolean;
    /** Sandboxes on this computer, and how many of them run; undefined while the engine cannot be asked. */
    sandboxes: number | undefined;
    running: number | undefined;
    /** A change of mode asked for here, until ic answers, and why the last one did not take. */
    setting: EngineMode | undefined;
    modeError: string | undefined;
    /** Stop now or Start, until ic answers, and the last one that did not take. */
    toggling: `stop` | `start` | undefined;
    toggleError: { readonly verb: `stop` | `start`; readonly reason: string } | undefined;
    /** Another run on this computer (a move between engines, a setup): nothing here changes the engine under it. */
    busy: boolean;
}>();
const emit = defineEmits<{ mode: [mode: EngineMode]; stop: []; start: [] }>();

const choices = computed(() => modeOptions(props.sandboxes));
const shownMode = computed(() => props.setting ?? props.mode);
const pick = (mode: EngineMode | undefined): void => {
    if (mode !== undefined && mode !== props.mode) {
        emit(`mode`, mode);
    }
};

const now = computed(() => nowOf({ status: props.status, listening: props.listening, starting: props.starting, toggling: props.toggling }));
const words = computed(() => nowWords(now.value, props.running, props.status.wslMemoryBytes));
const others = computed(() => othersKeepWsl(now.value, props.status.otherDistros, props.status.wslMemoryBytes));
const press = computed(() => nowPress(now.value, props.toggling));
const moving = computed(() => now.value.kind === `starting` || now.value.kind === `stopping`);
const dot = computed(() => (now.value.kind === `running` ? `success` : now.value.kind === `down` ? `warning` : `neutral`));
// The figure Task Manager shows by another name: the whole VM's, the reader's own distros included.
const memoryTip = computed((): Tip => ({ title: t(`desktop.background.now.memoryTitle`), note: t(`desktop.background.now.memoryNote`) }));
const held = computed(() => props.busy || props.setting !== undefined || props.toggling !== undefined);

const startupOff = computed(() => startupSwitchedOff(props.status));

// One pair: the name quiet on the left, its value on the right, at a row's own inset; the name over its value on a card
// too narrow for both, where the 7rem name left the value a column a few words wide.
const PAIR = `@container/pair flex min-w-0 flex-wrap items-start gap-x-3 px-4 py-2.5`;
const NAME = `shrink-0 basis-full pt-1 text-xs text-subtle @sm/pair:w-28 @sm/pair:basis-auto @sm/pair:py-1`;
const VALUE = `flex min-w-0 flex-1 flex-col items-start gap-0.5`;
</script>

<template>
    <RowGroup :label="t(`desktop.background.title`)" data-background>
        <!-- What this is for, once, behind the (i): the rows under it start with the setting itself. -->
        <template #info>
            <InfoHint :label="t(`desktop.background.about`)">
                <span class="flex flex-col gap-2 text-xs text-content">
                    <span class="font-medium">{{ t(`desktop.background.info.headline`) }}</span>
                    <span class="flex flex-col gap-1 border-t border-line-subtle pt-2 text-muted">
                        <span>{{ t(`desktop.background.info.vmmem`) }}</span>
                        <span>{{ t(`desktop.background.info.stop`) }}</span>
                        <span>{{ t(`desktop.background.info.tray`) }}</span>
                    </span>
                </span>
            </InfoHint>
        </template>

        <dl :class="PAIR">
            <dt :class="NAME">{{ t(`desktop.background.keepRunning`) }}</dt>
            <dd :class="VALUE">
                <!-- The value is the press: each choice says what it does to this computer's own sandboxes. -->
                <Picker
                    :model-value="shownMode"
                    :options="choices"
                    variant="ghost"
                    :disabled="held"
                    :aria-label="t(`desktop.background.keepRunning`)"
                    :header="t(`desktop.background.keepRunning`)"
                    class="-mx-1.5 self-start text-sm font-normal"
                    @update:model-value="pick"
                />
                <span v-if="setting" role="status" class="inline-flex items-center gap-1.5 text-xs text-subtle">
                    <Icon name="spinner" spin class="shrink-0" aria-hidden="true" />{{ t(`desktop.background.changing`) }}
                </span>
                <span v-else class="text-xs text-subtle">{{ modeMeaning(mode) }}</span>
                <p v-if="modeError" class="text-xs break-words text-danger">{{ t(`desktop.background.didntChange`, { reason: modeError }) }}</p>
            </dd>
        </dl>

        <dl :class="PAIR" :aria-busy="moving">
            <dt :class="NAME">{{ t(`desktop.background.now.label`) }}</dt>
            <dd :class="VALUE">
                <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 py-1 text-sm text-content">
                    <Icon v-if="moving" name="spinner" spin class="shrink-0 text-xs text-subtle" aria-hidden="true" />
                    <span v-else :class="toneDot(dot, `size-2 shrink-0 rounded-full`)" aria-hidden="true" />
                    <span class="ml-0.5">{{ words.state }}</span>
                    <!-- Each part with the point before it, so a narrow card breaks between parts, never after a point. -->
                    <span v-if="words.sandboxes" class="whitespace-nowrap"><span class="mr-1.5 text-subtle" aria-hidden="true">·</span>{{ words.sandboxes }}</span>
                    <span v-if="words.memory" class="whitespace-nowrap tabular-nums" v-tooltip.top="memoryTip"
                        ><span class="mr-1.5 text-subtle" aria-hidden="true">·</span>{{ words.memory }}</span
                    >
                </span>
                <!-- Stopped, and VmmemWSL still there: the reader's own distros keep WSL up, which no press here changes. -->
                <span v-if="others" class="text-xs text-subtle">{{ others }}</span>
                <p v-if="toggleError" class="text-xs break-words text-danger">
                    {{ t(`desktop.background.didnt.${toggleError.verb}`, { reason: toggleError.reason }) }}
                </p>
            </dd>
            <dd v-if="press" class="shrink-0">
                <Button
                    size="small"
                    :tier="press.tier"
                    :label="press.verb === `stop` ? t(`desktop.background.stopNow`) : t(`desktop.background.start`)"
                    :loading="toggling === press.verb"
                    :disabled="held"
                    @click="press.verb === `stop` ? emit(`stop`) : emit(`start`)"
                />
            </dd>
        </dl>

        <!-- Windows' own switch says the opposite of the setting: what is true now, and the one press that mends it. -->
        <RowNote v-if="startupOff" icon="exclamation-triangle" tone="warning">
            <span class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span>{{ t(`desktop.background.startupOff`) }}</span>
                <Button
                    size="small"
                    tier="accent"
                    :label="t(`desktop.background.switchBackOn`)"
                    :loading="setting === `always`"
                    :disabled="held"
                    @click="emit(`mode`, `always`)"
                />
            </span>
        </RowNote>
    </RowGroup>
</template>
