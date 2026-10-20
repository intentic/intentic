<script setup lang="ts">
import { Picker, type PickerOption, Row, RowGroup, RowNote } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import { chooseMic, chosenMic, listMics, type MicList, onMicsChanged } from "../../models/voice/micChoice";
import { type LastHeard, useWakeListener } from "../../models/voice/useWakeListener";
import { meterShare, SPEECH_START_LEVEL } from "../../models/voice/voiceAudio";

// The microphone this device hears with, for the wake word and dictation alike (micChoice.ts), and, while it listens
// for the wake word, proof that it hears: the device it opened, a live level against the mark a phrase has to pass, and
// what the model last wrote down with what that came to. Without these a wrong microphone, a muted one and a name the
// model spells differently all looked the same: nothing happened.

const t = useT();
const listener = useWakeListener();
const word = computed(() => listener.word.value);

// The browser's own choice. Chromium's own alias for it carries the same id, and listMics leaves that one out.
const BROWSER = `default`;
const NONE: MicList = { mics: [], named: false };

const list = shallowRef<MicList>(NONE);
const refresh = async (): Promise<void> => {
    // allow(silent-catch): a page that may not see devices (an insecure address) lists none, and the note says why names are missing.
    list.value = await listMics().catch(() => NONE);
};
void refresh();
// A page without mediaDevices (an insecure address) has no device to hear being plugged in.
const stopWatching = navigator.mediaDevices === undefined ? () => {} : onMicsChanged(() => void refresh());
// Names arrive with the permission, which listening starting is the sign of.
watch(
    () => listener.phase.value,
    (phase) => {
        if (phase === `listening`) {
            void refresh();
        }
    },
);
onBeforeUnmount(stopWatching);

const options = computed<PickerOption[]>(() => {
    const listed = list.value.mics.map((mic, index) => ({
        value: mic.id,
        label: mic.label === `` ? t(`settings.settingsVoice.micUnnamed`, { n: index + 1 }) : mic.label,
    }));
    const chosen = chosenMic.value;
    // A pick that is unplugged now stays picked, and comes back into use when it does.
    const away = chosen !== undefined && list.value.named && !listed.some((option) => option.value === chosen);
    return [
        { value: BROWSER, label: t(`settings.settingsVoice.micDefault`) },
        ...listed,
        ...(away ? [{ value: chosen, label: t(`settings.settingsVoice.micAway`) }] : []),
    ];
});

const picked = computed({
    get: () => chosenMic.value ?? BROWSER,
    set: (id: string | undefined) => chooseMic(id === undefined || id === BROWSER ? undefined : id),
});

const listening = computed(() => listener.phase.value === `listening`);
const share = computed(() => Math.round(meterShare(listener.level.value) * 100));
const mark = `${Math.round(meterShare(SPEECH_START_LEVEL) * 100)}%`;
const using = computed(() => {
    const mic = listener.micLabel.value;
    return mic === undefined ? t(`settings.settingsVoice.listeningWithBrowser`) : t(`settings.settingsVoice.listeningWith`, { mic });
});

const lineFor = (heard: LastHeard): string => {
    if (heard.text === ``) {
        return t(`settings.settingsVoice.heardNothing`);
    }
    switch (heard.verdict) {
        case `name`:
            return t(`settings.settingsVoice.heardName`, { text: heard.text, word: word.value });
        case `request`:
            return t(`settings.settingsVoice.heardRequest`, { text: heard.text });
        case `talk`:
            return t(`settings.settingsVoice.heardTalk`, { text: heard.text, word: word.value });
    }
};
const heardLine = computed(() => {
    const heard = listener.lastHeard.value;
    return heard === undefined ? t(`settings.settingsVoice.heardNone`, { word: word.value }) : lineFor(heard);
});
</script>

<template>
    <RowGroup data-setting="microphone" :label="t(`settings.settingsVoice.micGroup`)">
        <Row icon="microphone" :title="t(`settings.settingsVoice.mic`)" :description="t(`settings.settingsVoice.micNote`, { word })">
            <template #control>
                <Picker v-model="picked" :options="options" :aria-label="t(`settings.settingsVoice.mic`)" class="max-w-64 text-sm" />
            </template>
        </Row>
        <RowNote v-if="!list.named" icon="info-circle">{{ t(`settings.settingsVoice.micNames`) }}</RowNote>
        <template v-if="listening">
            <Row icon="microphone" :title="using" :description="t(`settings.settingsVoice.levelNote`)" indent>
                <template #control>
                    <div
                        role="meter"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        :aria-valuenow="share"
                        :aria-label="using"
                        class="relative h-1.5 w-32 overflow-hidden rounded-full bg-content/10"
                    >
                        <div class="h-full rounded-full bg-primary-500" :style="{ width: `${share}%` }" />
                        <div class="absolute inset-y-0 w-px bg-content/70" :style="{ left: mark }" />
                    </div>
                </template>
            </Row>
            <Row icon="comments" :title="t(`settings.settingsVoice.lastHeard`)" :description="heardLine" indent />
            <RowNote icon="info-circle">{{ t(`settings.settingsVoice.heardPrivacy`) }}</RowNote>
        </template>
    </RowGroup>
</template>
