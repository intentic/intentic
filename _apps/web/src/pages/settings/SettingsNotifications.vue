<script setup lang="ts">
import { Row, RowGroup } from "@intentic-app/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { usePushNotifications } from "../../composables/usePushNotifications";

/* Notifications: whether this sandbox may reach you when you are not looking at it.
 *
 * Two things are worth being explicit about on this page, because both surprise people:
 *   - it is PER BROWSER. A push subscription belongs to the browser that created it, so enabling here says
 *     nothing about your phone. The copy says so rather than letting the toggle imply an account-wide setting.
 *   - nothing is sent while you are watching. The daemon suppresses a notification whenever any tab on this
 *     sandbox is present and not idle, which is the difference between useful and irritating. */

const { state, busy, error, canToggle, enable, disable, sendTest } = usePushNotifications();

const enabled = computed(() => state.value === `on`);

const toggle = (next: boolean): void => void (next ? enable() : disable());

// One line per genuinely different situation. `denied` is the important one: the page cannot re-prompt after a
// block, so telling the user to flip the toggle again would be advice that cannot work.
const status = computed(() => {
    switch (state.value) {
        case `unsupported`:
            return `This browser can't receive push notifications. Safari needs the app added to your Home Screen first.`;
        case `denied`:
            return `Blocked for this site. Your browser won't ask again — re-allow notifications in its site settings, then reload.`;
        case `on`:
            return `This browser will be notified when a turn finishes, when the agent needs an answer, and when an automation is waiting for approval.`;
        default:
            return `Get told when your agent finishes or needs you, without keeping the tab open.`;
    }
});
</script>

<template>
    <div class="flex flex-col gap-6">
        <RowGroup label="Push notifications">
            <Row icon="bolt" title="Notify this browser" :description="status">
                <template #control><ToggleSwitch :model-value="enabled" :disabled="!canToggle" @update:model-value="toggle" /></template>
            </Row>
            <Row
                icon="desktop"
                title="Per browser, per device"
                description="A subscription belongs to the browser that created it — turn this on again on each device you want notified."
            />
            <Row
                icon="eye"
                title="Quiet while you're watching"
                description="Nothing is sent while a tab on this sandbox is open and active. You're only notified when you've actually stepped away."
            />
            <Row
                v-if="enabled"
                icon="send"
                title="Send a test"
                description="Checks the whole chain — the sandbox, the push service, and your operating system's notification settings."
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

        <p v-if="error" class="text-xs text-danger">{{ error }}</p>
    </div>
</template>
