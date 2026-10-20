<script setup lang="ts">
import { Notice, Picker, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { pickSoundOutput, setMuted, setVolume, sound, soundError, soundOutputs } from "./settings";
import { currentOutputOf, outputOptionsOf, volumeIconOf } from "./soundCard";

// THE SOUND, on This computer when this computer runs Intentic OS (settings.ts holds it, the app's os_settings.rs runs
// `ic os sound`): how loud, sound on or off, and which speaker or headphones it plays on. The slider is sent once it
// rests, and shows where it was left meanwhile.

const t = useT();

const options = computed(() => (soundOutputs.value === undefined ? [] : outputOptionsOf(soundOutputs.value)));
const current = computed(() => (soundOutputs.value === undefined ? undefined : currentOutputOf(soundOutputs.value)));
const pick = (value: string | undefined): void => {
    const id = Number(value);
    if (value !== undefined && value !== current.value && Number.isInteger(id)) {
        void pickSoundOutput(id);
    }
};
const slid = (event: Event): void => {
    // SAFETY: bound on the range input below, whose value is its number as text.
    setVolume(Number((event.target as HTMLInputElement).value));
};
</script>

<template>
    <section v-if="sound" class="flex flex-col gap-3 rounded-xl border border-line p-4">
        <header class="flex items-start gap-2.5 text-sm">
            <Icon :name="volumeIconOf(sound)" class="shrink-0 text-link" />
            <div class="min-w-0 flex-1">
                <h2 class="text-sm leading-tight font-semibold">{{ t(`desktop.os.sound.title`) }}</h2>
                <p class="mt-1 text-xs text-muted">{{ sound.output ?? t(`desktop.os.sound.noOutput`) }}</p>
            </div>
        </header>

        <!-- HOW LOUD: the press beside the slider turns the sound off and on; moving the slider turns it back on. -->
        <div class="flex items-center gap-3">
            <button
                type="button"
                :class="ui.iconButton({ size: `md`, on: sound.muted })"
                :aria-pressed="sound.muted"
                :aria-label="sound.muted ? t(`desktop.os.sound.unmute`) : t(`desktop.os.sound.mute`)"
                @click="setMuted(!sound.muted)"
            >
                <Icon :name="volumeIconOf(sound)" />
            </button>
            <input
                type="range"
                min="0"
                max="100"
                step="1"
                :value="sound.volume"
                :aria-label="t(`desktop.os.sound.volume`)"
                :aria-valuetext="sound.muted ? t(`desktop.os.sound.muted`) : t(`desktop.os.sound.percent`, { percent: sound.volume })"
                class="min-w-0 flex-1 cursor-pointer accent-primary-600"
                @input="slid"
            />
            <span class="w-14 shrink-0 text-right text-xs text-muted tabular-nums">{{
                sound.muted ? t(`desktop.os.sound.muted`) : t(`desktop.os.sound.percent`, { percent: sound.volume })
            }}</span>
        </div>

        <!-- WHERE IT PLAYS: offered only where there is more than one place. -->
        <div v-if="options.length > 1" class="flex flex-wrap items-center gap-2">
            <span class="text-2xs text-subtle">{{ t(`desktop.os.sound.playsOn`) }}</span>
            <Picker
                :model-value="current"
                :options="options"
                variant="input"
                :aria-label="t(`desktop.os.sound.playsOn`)"
                :header="t(`desktop.os.sound.playsOn`)"
                class="ui-field-sm min-w-0 flex-1"
                @update:model-value="pick"
            />
        </div>

        <Notice v-if="soundError" tone="warning" class="text-2xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="soundError = undefined">
            <span class="block font-medium">{{ t(`desktop.os.sound.didntChange`) }}</span>
            <span class="mt-0.5 block font-mono break-words">{{ soundError }}</span>
        </Notice>
    </section>
</template>
