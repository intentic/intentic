<script setup lang="ts">
import { Button, Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, onMounted, watch } from "vue";
import { usePushNotifications } from "../../push/usePushNotifications";
import { type Chime, playChime } from "../../shell/browser-tab/chimes";
import { sendTestNotice } from "../../shell/browser-tab/desktopSignal";
import { chimeAsks, chimeFinished, noticeAsks, noticeFinished, tabStatus } from "../../shell/browser-tab/tabPreferences";
import { desktopVersion } from "../../app/environments/desktop";
import { askDesktopNoticeSetting, desktopNotices, desktopNoticeSetting } from "../../app/environments/desktopNotices";
import { readerHere } from "../../shell/browser-tab/readerHere";
import { pushUnsupportedReason } from "./pushAdvice";
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

// Inside a desktop app that puts up the system's notifications and marks its icon (desktopSignal.ts, desktopBadge.ts):
// its window takes no push, has no tab and lives in the tray, so these are the app's own surfaces for the same news.
const inApp = desktopNotices();

// A system with notifications switched off drops every one without a word, so the app is asked whether it shows them:
// as this opens, after a test, and whenever the reader comes back (from the system's own settings, likely as not).
const askSystem = (): void => {
    if (inApp) {
        askDesktopNoticeSetting();
    }
};
onMounted(askSystem);
watch(readerHere, (here) => {
    if (here) {
        askSystem();
    }
});
const sendDesktopTest = (): void => {
    sendTestNotice();
    askSystem();
};
const systemOff = computed((): string | undefined => {
    switch (desktopNoticeSetting.value) {
        case `off-user`:
            return t(`settings.settingsNotifications.systemOffUser`);
        case `off-app`:
            return t(`settings.settingsNotifications.systemOffApp`);
        case `off-policy`:
            return t(`settings.settingsNotifications.systemOffPolicy`);
        case `none`:
            return t(`settings.settingsNotifications.systemNoService`);
        default:
            return undefined;
    }
});

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
// Why this window can't take push, in the words that fit it: the Home Screen only where adding the app there helps.
const unsupportedLine = (): string => {
    const reason = pushUnsupportedReason({
        userAgent: globalThis.navigator?.userAgent ?? ``,
        desktopApp: desktopVersion() !== undefined,
        standalone: globalThis.matchMedia?.(`(display-mode: standalone)`).matches ?? false,
        maxTouchPoints: globalThis.navigator?.maxTouchPoints ?? 0,
    });
    if (reason === `home-screen`) {
        return t(`settings.settingsNotifications.unsupportedHomeScreen`);
    }
    if (reason === `desktop-app`) {
        return inApp ? t(`settings.settingsNotifications.unsupportedDesktopAppNotices`) : t(`settings.settingsNotifications.unsupportedDesktopApp`);
    }
    return t(`settings.settingsNotifications.unsupportedBrowser`);
};

// One line per distinct state; `denied` matters since the page cannot re-prompt after a block.
const status = computed(() => {
    switch (state.value) {
        case `unsupported`:
            return unsupportedLine();
        case `denied`:
            return `Blocked for this app. Re-allow notifications in site settings, then reload.`;
        default:
            return undefined;
    }
});
</script>

<template>
    <div class="flex flex-col gap-6">
        <div v-if="inApp" class="flex flex-col gap-2">
            <RowGroup :label="t(`settings.settingsNotifications.desktopNotices`)" equal-rows>
                <Row
                    as="label"
                    icon="exclamation-circle"
                    :title="t(`settings.settingsNotifications.chimeAsks`)"
                    :description="t(`settings.settingsNotifications.chimeAsksHint`)"
                >
                    <template #control><ToggleSwitch v-model="noticeAsks" /></template>
                </Row>
                <Row
                    as="label"
                    icon="check-circle"
                    :title="t(`settings.settingsNotifications.chimeFinished`)"
                    :description="t(`settings.settingsNotifications.chimeFinishedHint`)"
                >
                    <template #control><ToggleSwitch v-model="noticeFinished" /></template>
                </Row>
                <Row icon="send" :title="t(`settings.settingsNotifications.sendTest`)">
                    <template #control>
                        <Button size="small" severity="secondary" @click="sendDesktopTest">
                            {{ t(`settings.settingsNotifications.sendTest2`) }}
                        </Button>
                    </template>
                </Row>
            </RowGroup>
            <p v-if="systemOff" class="text-xs text-warning">{{ systemOff }}</p>
            <p v-else class="text-xs text-muted">{{ t(`settings.settingsNotifications.desktopNoticesWhen`) }}</p>
        </div>

        <div class="flex flex-col gap-2">
            <RowGroup :label="t(`settings.settingsNotifications.pushNotifications`)" equal-rows>
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
            <p v-if="error" class="text-xs text-danger">{{ error }}</p>
            <p v-else-if="sent" class="text-xs text-muted">{{ sent }}</p>
        </div>

        <!-- One switch for one mark: the tab's in a browser, the app's icon in the app, whose window has no tab. -->
        <RowGroup :label="inApp ? t(`settings.settingsNotifications.appIcon`) : t(`settings.settingsNotifications.browserTab`)">
            <Row
                as="label"
                :icon="inApp ? `desktop` : `browsers`"
                :title="inApp ? t(`settings.settingsNotifications.appIconStatus`) : t(`settings.settingsNotifications.tabStatus`)"
                :description="inApp ? t(`settings.settingsNotifications.appIconStatusHint`) : t(`settings.settingsNotifications.tabStatusHint`)"
            >
                <template #control><ToggleSwitch v-model="tabStatus" /></template>
            </Row>
        </RowGroup>

        <div class="flex flex-col gap-2">
            <RowGroup :label="t(`settings.settingsNotifications.sounds`)" equal-rows>
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
            <p class="text-xs text-muted">{{ inApp ? t(`settings.settingsNotifications.chimesWhenApp`) : t(`settings.settingsNotifications.chimesWhen`) }}</p>
        </div>
    </div>
</template>
