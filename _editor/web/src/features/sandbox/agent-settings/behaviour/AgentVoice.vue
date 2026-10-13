<script setup lang="ts">
import {
    CloudVoiceProviderSchema,
    isCloudVoiceEngine,
    type VoiceSettings,
    VoiceSettingsSchema,
    voiceEngineOf,
    WAKE_WORD_DEFAULT,
    WakeWordSchema,
} from "@intentic/sandbox-contract";
import { Icon, Notice, type NoticeModel, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { activeLocale, useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, useId } from "vue";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { sandboxRaw } from "../../../../client/sandbox/sandboxRaw";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { SPEECH_VOICES } from "../../../../lib/queryKeys";
import { queryClient } from "../../../../lib/queryPersistence";
import { useSpeechPlayer } from "../../../chat/voice/speechPlayer";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import {
    defaultVoiceFor,
    initialLanguage,
    languageChoices,
    pickedVoices,
    PROVIDER_NAMES,
    sampleSentence,
    speedChoices,
    voiceChoices,
    withCloudField,
    withProvider,
    withVoiceFor,
} from "./agentVoice";

// How the agent's replies are spoken (SandboxSettings.voice, schemas/voice.ts): whether a hands-free turn is answered
// out loud, which voice speaks each language, and a speech provider of the owner's own. The daemon reads these on every
// utterance (speech/voice/voice.ts), so a change is heard on the next sentence; the choices themselves come from
// GET /speech/voices, which says what this sandbox can speak with and whether the provider's key resolves.

const t = useT();

const { settings, save, refusal } = useSandboxSettings();
const voice = computed((): VoiceSettings => settings.value?.voice ?? VoiceSettingsSchema.parse({}));
const ready = computed(() => settings.value !== undefined);

const { query: voicesRead, error: voicesError } = useSandboxQuery({
    queryKey: SPEECH_VOICES.of(),
    queryFn: () => sandboxRaw(`GET /speech/voices`),
});
const view = computed(() => voicesRead.data.value);
const refreshVoices = (): void => void queryClient.invalidateQueries({ queryKey: SPEECH_VOICES.of() });

// The voice settings travel as one object, so every control writes the whole of it back. Through the settings'
// own save rather than `patch`, for the one thing patch cannot say: when the write has landed, which is when the
// voices read can tell whether the provider's key resolves.
const saveVoice = (next: VoiceSettings): void => {
    const current = settings.value;
    if (current === undefined || next === voice.value) {
        return;
    }
    save.mutate({ ...current, voice: next }, { onSettled: refreshVoices });
};

const selectValue = (event: Event): string | undefined => (event.target instanceof HTMLSelectElement ? event.target.value : undefined);

const setSpeed = (event: Event): void => {
    const speed = Number(selectValue(event));
    if (Number.isFinite(speed) && speed >= 0.5 && speed <= 2) {
        saveVoice({ ...voice.value, speed });
    }
};
const speeds = computed(() => speedChoices(voice.value.speed));

// ---- the name it is called by ----

// The wake word every device of this sandbox listens for (chat/wake), written when the field is left. A word the model
// cannot write down is refused here, with why, rather than saved and never heard; a short one is saved, with the warning
// that it wakes by mistake.
const wakeDraft = ref<string>();
const wakeShown = computed(() => wakeDraft.value ?? voice.value.wake.word);
const wakeInvalid = computed(() => wakeDraft.value !== undefined && wakeDraft.value.trim() !== `` && !WakeWordSchema.safeParse(wakeDraft.value).success);
const wakeShort = computed(() => [...wakeShown.value.replaceAll(/\s/gu, ``)].length <= 3);
const onWakeInput = (event: Event): void => {
    if (event.target instanceof HTMLInputElement) {
        wakeDraft.value = event.target.value;
    }
};
const commitWake = (): void => {
    const next = wakeDraft.value?.trim();
    if (next === undefined || wakeInvalid.value) {
        return;
    }
    wakeDraft.value = undefined;
    const parsed = WakeWordSchema.safeParse(next === `` ? WAKE_WORD_DEFAULT : next);
    if (parsed.success && parsed.data !== voice.value.wake.word) {
        saveVoice({ ...voice.value, wake: { word: parsed.data } });
    }
};

// ---- which voice speaks a language ----

const languages = computed(() => (view.value === undefined ? [] : languageChoices(view.value, voice.value.cloud, activeLocale.value)));
// The language being looked at is the card's own state, not a setting: it opens on the reader's language and stays
// where it was put, unless what it was put on stops being spoken (its provider went).
const chosenLanguage = ref<string>();
const language = computed(() => {
    const chosen = chosenLanguage.value;
    return chosen !== undefined && languages.value.some((choice) => choice.value === chosen) ? chosen : initialLanguage(languages.value, activeLocale.value);
});
const setLanguage = (event: Event): void => {
    chosenLanguage.value = selectValue(event);
};

const voices = computed(() => (view.value === undefined ? [] : voiceChoices(view.value, voice.value, language.value)));
const picked = computed(() => voice.value.voices[language.value] ?? ``);
const setVoice = (event: Event): void => {
    const chosen = selectValue(event);
    if (chosen !== undefined) {
        saveVoice({ ...voice.value, voices: withVoiceFor(voice.value.voices, language.value, chosen) });
    }
};

const picks = computed(() => pickedVoices(voice.value.voices, view.value, activeLocale.value));
const removePick = (pickedLanguage: string): void => saveVoice({ ...voice.value, voices: withVoiceFor(voice.value.voices, pickedLanguage, ``) });

// ---- hearing it ----

// The page's one player, so a preview stops a reply being read and the other way round. Plays what the select shows:
// the pick, or what speaks the language without one.
const player = useSpeechPlayer();
const previewVoice = computed(() => (picked.value !== `` ? picked.value : view.value === undefined ? undefined : defaultVoiceFor(view.value, voice.value.cloud, language.value)));
const previewKey = computed(() => (previewVoice.value === undefined ? undefined : `preview:${previewVoice.value}`));
const previewing = computed(() => previewKey.value !== undefined && player.speaking.value === previewKey.value);
const previewWaiting = computed(() => previewing.value && player.state.value !== `speaking`);
// A local voice on a machine that cannot run one would only fail; a provider's voice still speaks there.
const canPreview = computed(() => {
    const id = previewVoice.value;
    return id !== undefined && (view.value?.provisioned !== false || isCloudVoiceEngine(voiceEngineOf(id)));
});
const previewLabel = computed(() => {
    if (!previewing.value) {
        return t(`sandbox.agentVoice.play`);
    }
    if (player.state.value === `downloading`) {
        return t(`sandbox.agentVoice.downloading`, { percent: Math.round((player.progress.value ?? 0) * 100) });
    }
    return previewWaiting.value ? t(`sandbox.agentVoice.preparing`) : t(`sandbox.agentVoice.stop`);
});
// The player's last word stays on screen only once this card has asked it for something.
const previewed = ref(false);
const previewNotice = computed(() => (previewed.value ? player.notice.value : undefined));

const togglePreview = (): void => {
    if (previewing.value) {
        player.stop();
        return;
    }
    const id = previewVoice.value;
    const key = previewKey.value;
    if (id === undefined || key === undefined) {
        return;
    }
    previewed.value = true;
    // A first preview of a voice may have downloaded its model, which the list then stops offering as a download.
    void player.say(sampleSentence(language.value), { key, voice: id, as: `plain`, lang: language.value }).then(refreshVoices);
};

// ---- a provider of the owner's own ----

const cloud = computed(() => voice.value.cloud);
const providers = computed(() => [
    { value: ``, label: t(`sandbox.agentVoice.none`) },
    ...CloudVoiceProviderSchema.options.map((provider) => ({ value: provider, label: PROVIDER_NAMES[provider] })),
]);
const setProvider = (event: Event): void => {
    const chosen = selectValue(event);
    if (chosen === undefined) {
        return;
    }
    const provider = CloudVoiceProviderSchema.safeParse(chosen);
    saveVoice(withProvider(voice.value, provider.success ? provider.data : undefined));
};

// Written when the field is left, not per keystroke; the field is put back to what was kept, so an emptied secret name
// shows the one still in force.
const commitCloud = (field: `secret` | `model` | `voice`) => (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
        return;
    }
    const next = withCloudField(voice.value, field, input.value);
    input.value = next.cloud?.[field] ?? ``;
    saveVoice(next);
};
const commitSecret = commitCloud(`secret`);
const commitModel = commitCloud(`model`);
const commitCloudVoice = commitCloud(`voice`);

// The names the Secrets page lists that hold a value someone set, offered as the field is typed in; read only while a
// provider is connected, since the inventory is a fan-out over every store.
const { query: inventoryRead } = useSandboxQuery({ ...rpcQuery(`secrets.inventory`), enabled: computed(() => cloud.value !== undefined) });
const secretNames = computed(() =>
    (inventoryRead.data.value?.entries ?? [])
        .filter((entry) => (entry.kind === `env` || entry.kind === `generated`) && entry.status !== `missing`)
        .map((entry) => entry.key)
        .toSorted(),
);
const secretList = useId();

// Said only once the voices read speaks for the provider the settings name; a read from before the change would
// answer for the old one.
const keyFound = computed(() => {
    const read = view.value?.cloud;
    return read === undefined || read.provider !== cloud.value?.provider ? undefined : read.ready;
});

const voicesFailure = computed<NoticeModel | undefined>(() =>
    voicesError.value === undefined ? undefined : { tone: `warning`, title: t(`sandbox.agentVoice.unavailable`), detail: voicesError.value },
);
</script>

<template>
    <RowGroup :label="t(`sandbox.agentVoice.group`)">
        <Row icon="volume-up" :title="t(`sandbox.agentVoice.replies`)" :description="t(`sandbox.agentVoice.repliesNote`)">
            <template #control>
                <ToggleSwitch
                    :model-value="voice.replies"
                    :disabled="!ready"
                    :aria-label="t(`sandbox.agentVoice.replies`)"
                    @update:model-value="(value: boolean) => saveVoice({ ...voice, replies: value })"
                />
            </template>
        </Row>

        <!-- Off by default: a laptop's speakers without echo cancellation feed its own voice back as the person's. -->
        <Row icon="microphone" :title="t(`sandbox.agentVoice.interrupt`)" :description="t(`sandbox.agentVoice.interruptNote`)">
            <template #control>
                <ToggleSwitch
                    :model-value="voice.interrupt"
                    :disabled="!ready"
                    :aria-label="t(`sandbox.agentVoice.interrupt`)"
                    @update:model-value="(value: boolean) => saveVoice({ ...voice, interrupt: value })"
                />
            </template>
        </Row>

        <Row icon="sliders-h" :title="t(`sandbox.agentVoice.speed`)" :description="t(`sandbox.agentVoice.speedNote`)">
            <template #control>
                <select
                    class="ui-field-box ui-field-sm w-24"
                    :aria-label="t(`sandbox.agentVoice.speed`)"
                    :value="String(voice.speed)"
                    :disabled="!ready"
                    @change="setSpeed"
                >
                    <option v-for="speed in speeds" :key="speed.value" :value="speed.value">{{ speed.label }}</option>
                </select>
            </template>
        </Row>

        <!-- The name every device of this sandbox listens for, where a reader switched listening on (Settings ▸ Voice). -->
        <Row icon="microphone" :title="t(`sandbox.agentVoice.wakeWord`)" :description="t(`sandbox.agentVoice.wakeWordNote`)">
            <template #control>
                <input
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    maxlength="40"
                    :aria-label="t(`sandbox.agentVoice.wakeWord`)"
                    :aria-invalid="wakeInvalid"
                    :class="ui.input({ size: `sm` }, `w-40`)"
                    :value="wakeShown"
                    :disabled="!ready"
                    @input="onWakeInput"
                    @change="commitWake"
                />
            </template>
        </Row>
        <RowNote v-if="wakeInvalid" icon="exclamation-triangle" tone="warning">{{ t(`sandbox.agentVoice.wakeWordInvalid`) }}</RowNote>
        <RowNote v-else-if="wakeShort" icon="exclamation-triangle" tone="warning">{{ t(`sandbox.agentVoice.wakeWordShort`) }}</RowNote>

        <!-- One language at a time: the picker shows what speaks it now, and the list under it every language given a voice of its own. -->
        <Row
            v-if="view !== undefined"
            icon="globe"
            :title="t(`sandbox.agentVoice.voiceFor`)"
            :description="t(`sandbox.agentVoice.voiceForNote`)"
            wide-control
            indent
        >
            <template #control>
                <div class="flex flex-wrap items-center gap-2">
                    <select class="ui-field-box ui-field-sm w-36" :aria-label="t(`sandbox.agentVoice.language`)" :value="language" @change="setLanguage">
                        <option v-for="choice in languages" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
                    </select>
                    <select
                        class="ui-field-box ui-field-sm w-60"
                        :aria-label="t(`sandbox.agentVoice.voice`)"
                        :value="picked"
                        :disabled="!ready"
                        @change="setVoice"
                    >
                        <option v-for="choice in voices" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
                    </select>
                    <button
                        type="button"
                        :class="ui.textButton({ tone: `quiet` }, `font-medium tabular-nums`)"
                        :disabled="!canPreview"
                        :aria-pressed="previewing"
                        @click="togglePreview"
                    >
                        <Icon :name="previewWaiting ? `spinner` : previewing ? `stop` : `play`" :spin="previewWaiting" />{{ previewLabel }}
                    </button>
                </div>
            </template>
            <template v-if="picks.length > 0" #below>
                <ul class="flex flex-col gap-0.5" :aria-label="t(`sandbox.agentVoice.picked`)">
                    <li v-for="pick in picks" :key="pick.language" class="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                        <span class="min-w-0 truncate">{{ t(`sandbox.agentVoice.override`, { language: pick.languageLabel, voice: pick.voiceLabel }) }}</span>
                        <button
                            type="button"
                            :class="ui.iconButton({ size: `xs`, tone: `danger` })"
                            :aria-label="t(`sandbox.agentVoice.removeOverride`, { language: pick.languageLabel })"
                            v-tooltip.top="t(`ui.action.remove`)"
                            :disabled="!ready"
                            @click="removePick(pick.language)"
                        >
                            <Icon name="times" class="text-2xs" />
                        </button>
                    </li>
                </ul>
            </template>
        </Row>
        <RowNote v-if="previewNotice !== undefined" icon="exclamation-triangle" tone="warning">{{ previewNotice }}</RowNote>
        <RowNote v-if="view?.provisioned === false" icon="exclamation-triangle" tone="warning">{{ t(`sandbox.agentVoice.unprovisioned`) }}</RowNote>
        <RowNote v-if="voicesFailure !== undefined" variant="block"><Notice :of="voicesFailure" /></RowNote>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>

    <!-- The owner's own account with a speech service: better voices, at the price of the words leaving the sandbox. -->
    <RowGroup :label="t(`sandbox.agentVoice.providerGroup`)">
        <Row icon="cloud" :title="t(`sandbox.agentVoice.provider`)" :description="t(`sandbox.agentVoice.providerNote`)">
            <template #control>
                <select
                    class="ui-field-box ui-field-sm w-36"
                    :aria-label="t(`sandbox.agentVoice.provider`)"
                    :value="cloud?.provider ?? ``"
                    :disabled="!ready"
                    @change="setProvider"
                >
                    <option v-for="choice in providers" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
                </select>
            </template>
        </Row>
        <template v-if="cloud !== undefined">
            <Row icon="key" :title="t(`sandbox.agentVoice.secret`)" :description="t(`sandbox.agentVoice.secretNote`)">
                <template #control>
                    <input
                        type="text"
                        autocomplete="off"
                        spellcheck="false"
                        :list="secretList"
                        :aria-label="t(`sandbox.agentVoice.secret`)"
                        :class="ui.input({ size: `sm` }, `w-56 font-mono`)"
                        :value="cloud.secret"
                        :disabled="!ready"
                        @change="commitSecret"
                    />
                    <datalist :id="secretList">
                        <option v-for="name in secretNames" :key="name" :value="name" />
                    </datalist>
                </template>
            </Row>
            <RowNote v-if="keyFound === true" icon="check-circle" tone="success">{{ t(`sandbox.agentVoice.keyFound`) }}</RowNote>
            <RowNote v-else-if="keyFound === false" icon="exclamation-triangle" tone="warning">{{ t(`sandbox.agentVoice.keyMissing`) }}</RowNote>
            <Row icon="cpu" :title="t(`sandbox.agentVoice.model`)" :description="t(`sandbox.agentVoice.modelNote`)">
                <template #control>
                    <input
                        type="text"
                        autocomplete="off"
                        spellcheck="false"
                        :placeholder="t(`sandbox.agentVoice.modelPlaceholder`)"
                        :aria-label="t(`sandbox.agentVoice.model`)"
                        :class="ui.input({ size: `sm` }, `w-56 font-mono`)"
                        :value="cloud.model"
                        :disabled="!ready"
                        @change="commitModel"
                    />
                </template>
            </Row>
            <Row icon="waveform" :title="t(`sandbox.agentVoice.cloudVoice`)" :description="t(`sandbox.agentVoice.cloudVoiceNote`)">
                <template #control>
                    <input
                        type="text"
                        autocomplete="off"
                        spellcheck="false"
                        :placeholder="t(`sandbox.agentVoice.cloudVoicePlaceholder`)"
                        :aria-label="t(`sandbox.agentVoice.cloudVoice`)"
                        :class="ui.input({ size: `sm` }, `w-56 font-mono`)"
                        :value="cloud.voice"
                        :disabled="!ready"
                        @change="commitCloudVoice"
                    />
                </template>
            </Row>
            <RowNote icon="info-circle">{{ t(`sandbox.agentVoice.sentTo`, { provider: PROVIDER_NAMES[cloud.provider] }) }}</RowNote>
        </template>
    </RowGroup>
</template>
