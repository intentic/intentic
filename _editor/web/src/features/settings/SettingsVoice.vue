<script setup lang="ts">
import { Button, Row, RowGroup, RowNote } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useRole } from "../../client/sandbox/useRole";
import { useWakeListener } from "../../models/voice/useWakeListener";
import { wakeStatus } from "../../models/voice/wakeStatus";
import SettingsVoiceMic from "./SettingsVoiceMic.vue";

// Talking to the agent from across the room, on this device: whether this device listens for the wake word (its own
// microphone, so its own switch, kept in this browser) and where listening stands. The word itself is the sandbox's
// (SandboxSettings.voice.wake), the same on every device, so it is chosen beside the sandbox's other voice settings
// (Sandbox ▸ Agent ▸ Tools, AgentVoice.vue) and only named here. The listening is chat/wake's; this only switches it.

const t = useT();

const listener = useWakeListener();
const { canShip } = useRole();
const now = useNow(
    computed(() => listener.pausedUntil.value !== undefined),
    30_000,
);

const word = computed(() => listener.word.value);
const status = computed(() => wakeStatus(listener, now.value));

const paused = computed(() => listener.pausedUntil.value !== undefined && listener.pausedUntil.value > now.value);
const listening = computed(
    () => listener.enabled.value && !paused.value && (listener.phase.value === `listening` || listener.phase.value === `elsewhere`),
);

// Where the word is chosen: the sandbox's own Agent settings, which only a maintainer reaches.
const wordSettings = `/sandbox/agent?section=tools`;
</script>

<template>
    <div class="flex flex-col gap-6">
        <RowGroup data-setting="wake-word" :label="t(`settings.settingsVoice.group`)">
            <Row icon="microphone" :title="t(`settings.settingsVoice.listen`, { word })" :description="t(`settings.settingsVoice.listenNote`, { word })">
                <template #control>
                    <ToggleSwitch
                        :model-value="listener.enabled.value"
                        :aria-label="t(`settings.settingsVoice.listen`, { word })"
                        @update:model-value="(value: boolean) => listener.setEnabled(value)"
                    />
                </template>
            </Row>
            <Row v-if="status !== undefined" :icon="status.icon" :title="status.label" :description="status.detail" indent>
                <template #control>
                    <Button v-if="listening" size="small" thumb tier="quiet" @click="listener.pause(60)">{{ t(`settings.settingsVoice.pause`) }}</Button>
                    <Button v-else-if="paused" size="small" thumb tier="quiet" @click="listener.resume()">{{
                        t(`settings.settingsVoice.resume`)
                    }}</Button>
                </template>
            </Row>
            <Row icon="comments" :title="t(`settings.settingsVoice.word`)" :description="t(`settings.settingsVoice.wordNote`)">
                <template #control>
                    <span class="text-sm font-medium text-content">{{ word }}</span>
                </template>
            </Row>
            <RowNote v-if="canShip" icon="info-circle">
                <RouterLink :to="wordSettings" class="text-link hover:underline">{{ t(`settings.settingsVoice.wordChange`) }}</RouterLink>
            </RowNote>
            <RowNote v-else icon="info-circle">{{ t(`settings.settingsVoice.wordMaintainer`) }}</RowNote>
        </RowGroup>
        <SettingsVoiceMic />
    </div>
</template>
