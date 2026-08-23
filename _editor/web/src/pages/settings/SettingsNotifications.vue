<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { usePushNotifications } from "../../composables/usePushNotifications";

/* Notifications: whether this sandbox may reach you when you are not looking at it.
 *
 * Two things are worth being explicit about on this page, because both surprise people:
 *   - it is PER DEVICE. A registration belongs to the browser or phone that created it, so enabling here says
 *     nothing about any other device. The copy says so rather than letting the toggle imply an account-wide
 *     setting.
 *   - nothing is sent while you are watching. The daemon suppresses a notification whenever any tab on this
 *     sandbox is present and not idle, which is the difference between useful and irritating.
 *
 * Both live in the footnote UNDER the group, not as rows inside it. A <Row> with a title, a description and no
 * #control is visually indistinguishable from a setting whose switch failed to render, so caveats phrased as
 * rows get read as bugs. Everything on the bordered surface does something; everything that only explains sits
 * outside it, in the small muted type a grouped list already uses for footnotes. */

const { state, busy, error, delivered, canToggle, enable, disable, sendTest } = usePushNotifications();

const enabled = computed(() => state.value === `on`);

// What a successful test proves, said in the only terms that help when nothing appears on screen: the daemon
// did its half. That leaves exactly one suspect: this device's own notification settings (Focus/Do Not
// Disturb, or the browser muted at OS level), which is worth naming, because it is the one place the page
// cannot see and the user can. The plural matters: other browsers you enabled also got it.
const sent = computed(() => {
    if (delivered.value === undefined) {
        return undefined;
    }
    const where = delivered.value === 1 ? `1 registered device` : `${delivered.value} registered devices`;
    return `Sent to ${where}. If nothing appeared, the send worked and your system swallowed it. Check notification settings and Do Not Disturb for your browser.`;
});

const toggle = (next: boolean): void => void (next ? enable() : disable());

// One line per genuinely different situation. `denied` is the important one: the page cannot re-prompt after a
// block, so telling the user to flip the toggle again would be advice that cannot work.
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
                <Row
                    v-if="enabled"
                    icon="send"
                    title="Send a test"
                >
                    <template #control>
                        <button
                            type="button"
                            class="rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:bg-overlay hover:text-content disabled:opacity-40"
                            :disabled="busy"
                            @click="sendTest"
                        >
                            Send test
                        </button>
                    </template>
                </Row>
            </RowGroup>
        </div>

        <p v-if="error" class="text-xs text-danger">{{ error }}</p>
        <p v-else-if="sent" class="text-xs text-muted">{{ sent }}</p>
    </div>
</template>
