<script setup lang="ts">
import { Button, Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { usePushNotifications } from "../../push/usePushNotifications";

// Whether this sandbox may reach you when you're not looking at it. Per-device: enabling here does not affect other
// devices, and the daemon suppresses sends while any tab on this sandbox is open and active. Shown as a footnote under
// the group, not as rows, since a control-less Row reads as broken.

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
            <RowGroup label="Push notifications">
                <Row icon="bolt" title="Notify this device" :description="status">
                    <template #control><ToggleSwitch :model-value="enabled" :disabled="!canToggle" @update:model-value="toggle" /></template>
                </Row>
                <Row v-if="enabled" icon="send" title="Send a test">
                    <template #control>
                        <Button size="small" severity="secondary" :disabled="busy" @click="sendTest"> Send test </Button>
                    </template>
                </Row>
            </RowGroup>
        </div>

        <p v-if="error" class="text-xs text-danger">{{ error }}</p>
        <p v-else-if="sent" class="text-xs text-muted">{{ sent }}</p>
    </div>
</template>
