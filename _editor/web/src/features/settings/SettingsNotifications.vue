<script setup lang="ts">
import { Button, Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { usePushNotifications } from "../../push/usePushNotifications";
import { type Chime, playChime } from "../../shell/browser-tab/chimes";
import { chimeAsks, chimeFinished, tabStatus } from "../../shell/browser-tab/tabPreferences";
import { useT } from "@intentic/ui/i18n";

// Whether this sandbox may reach you when you're not looking at it. Per-device: enabling here does not affect other
// devices, and the daemon suppresses sends while any tab on this sandbox is open and active. Shown as a footnote under
// the group, not as rows, since a control-less Row reads as broken.

const t = useT();

const { state, busy, error, delivered, canToggle, enable, disable, sendTest } = usePushNotifications();

const enabled = computed(() => state.value === `on`);

// Proves only the daemon's half; a missing notification points to this device's own notification settings.
const sent = computed(() => {
    if (delivered.value === undefined) {
        return undefined;
    }
    const where = delivered.value === 1 ? `1 registered device` : `${delivered.value} registered devices`;
    return `Sent to ${where}. If nothing appeared, the send worked and your system swallowed it. Check notification settings and Do Not Disturb for your browser.`;
});

const toggle = (next: boolean): void => void (next ? enable() : disable());

// The browser tab's own signals (shell/browser-tab/): per browser, no daemon involved. A sound switched on is played at
// once, so the reader hears what they chose, and the click is what lets this page make sound at all later.
const chimeSwitch = (preference: typeof chimeAsks, chime: Chime) => (next: boolean): void => {
    preference.value = next;
    if (next) {
        void playChime(chime);
    }
};
const setChimeAsks = chimeSwitch(chimeAsks, `asks`);
const setChimeFinished = chimeSwitch(chimeFinished, `finished`);

// One line per distinct state; `denied` matters since the page cannot re-prompt after a block.
const status = computed(() => {
    switch (state.value) {
        case `unsupported`:
            return `This browser can't receive push notifications. Safari needs the app added to your Home Screen first.`;
        case `denied`:
            return `Blocked for this app. Re-allow notifications in site settings, then reload.`;
        default:
            return undefined;
    }
});
</script>

<template>
    <div class="flex flex-col gap-6">
        <div class="flex flex-col gap-2">
            <RowGroup :label="t(`settings.settingsNotifications.pushNotifications`)">
                <Row icon="bolt" :title="t(`settings.settingsNotifications.notifyDevice`)" :description="status">
                    <template #control><ToggleSwitch :model-value="enabled" :disabled="!canToggle" @update:model-value="toggle" /></template>
                </Row>
                <Row v-if="enabled" icon="send" :title="t(`settings.settingsNotifications.sendTest`)">
                    <template #control>
                        <Button size="small" severity="secondary" :disabled="busy" @click="sendTest">
                            {{ t(`settings.settingsNotifications.sendTest2`) }}
                        </Button>
                    </template>
                </Row>
            </RowGroup>
        </div>

        <p v-if="error" class="text-xs text-danger">{{ error }}</p>
        <p v-else-if="sent" class="text-xs text-muted">{{ sent }}</p>

        <RowGroup :label="t(`settings.settingsNotifications.browserTab`)">
            <Row
                as="label"
                icon="browsers"
                :title="t(`settings.settingsNotifications.tabStatus`)"
                :description="t(`settings.settingsNotifications.tabStatusHint`)"
            >
                <template #control><ToggleSwitch v-model="tabStatus" /></template>
            </Row>
        </RowGroup>

        <div class="flex flex-col gap-2">
            <RowGroup :label="t(`settings.settingsNotifications.sounds`)">
                <Row
                    as="label"
                    icon="exclamation-circle"
                    :title="t(`settings.settingsNotifications.chimeAsks`)"
                    :description="t(`settings.settingsNotifications.chimeAsksHint`)"
                >
                    <template #control><ToggleSwitch :model-value="chimeAsks" @update:model-value="setChimeAsks" /></template>
                </Row>
                <Row
                    as="label"
                    icon="check-circle"
                    :title="t(`settings.settingsNotifications.chimeFinished`)"
                    :description="t(`settings.settingsNotifications.chimeFinishedHint`)"
                >
                    <template #control><ToggleSwitch :model-value="chimeFinished" @update:model-value="setChimeFinished" /></template>
                </Row>
            </RowGroup>
            <p class="text-xs text-muted">{{ t(`settings.settingsNotifications.chimesWhen`) }}</p>
        </div>
    </div>
</template>
