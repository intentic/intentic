<!-- WHAT THIS DEVICE AND INTENTIC ITSELF ARE DOING, at the rail's foot whichever way the rail stands: folded over a sandbox
     (ShellDesktop.vue, above its tools) and unrolled onto every sandbox (MasterRail.vue, above the bookmark), since neither
     belongs to one sandbox. Each tile is there only while it has something to say, and the foot grows upward, so its
     arriving moves nothing:
     - the wake word, while listening is on for this device (models/voice/wakeStatus.ts): a press pauses it for an hour,
       brings it back, or opens the Voice settings where a stop is fixed;
     - Intentic's servers not answering, or this window open on its sandboxes without them (platformHealth.ts,
       directMode.ts): the sandboxes keep working, and what waits for the platform says so where it is pressed. A press
       opens the public status page; the tile goes by itself the moment the platform answers again. -->
<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { environment } from "../../../app/environments/environment";
import { directMode } from "../../../client/directory/directState";
import { settingsPartPath } from "../../../features/settings/settingsNav";
import { platformHealth } from "../../../lib/platform/platformHealth";
import { useWakeListener } from "../../../models/voice/useWakeListener";
import { wakeStatus, type WakeTone } from "../../../models/voice/wakeStatus";
import ToolTile from "./ToolTile.vue";

const t = useT();
const router = useRouter();

const listener = useWakeListener();
const now = useNow(computed(() => listener.pausedUntil.value !== undefined), 30_000);
const wake = computed(() => wakeStatus(listener, now.value));
// Hearing is a grey dot like any live tool; a stop is amber; quiet (paused, starting) none.
const WAKE_DOT = { quiet: undefined, active: `live`, warning: `warning` } as const satisfies Record<WakeTone, `live` | `warning` | undefined>;
const pressWake = (): void => {
    switch (wake.value?.press) {
        case `pause`:
            listener.pause(60);
            return;
        case `resume`:
            listener.resume();
            return;
        case `settings`:
            void router.push(settingsPartPath(`voice`));
            return;
        case `none`:
        case undefined:
            return;
    }
};

// Only intentic.dev has a status page; a self-hosted platform's api host names none.
const statusPage = ((): string | undefined => {
    try {
        return new URL(environment.api.url).hostname === `api.intentic.dev` ? `https://status.intentic.dev` : undefined;
    } catch {
        // allow(silent-catch): an api address that is not a URL names no status page.
        return undefined;
    }
})();
const offline = computed(() => platformHealth.down.value || directMode.value);
const pressOffline = (): void => {
    if (statusPage !== undefined) {
        globalThis.open(statusPage, `_blank`, `noopener`);
        return;
    }
    void platformHealth.checkNow();
};
</script>

<template>
    <ToolTile
        v-if="offline"
        section="platform"
        icon="cloud"
        :aria="t(`shell.platformStatus.detail`)"
        :tip="{ title: t(`shell.platformStatus.label`), tone: `warning`, note: t(`shell.platformStatus.note`) }"
        dot="warning"
        rail-key="tool:platform"
        @press="pressOffline"
    />
    <ToolTile
        v-if="wake !== undefined"
        section="wake"
        :icon="wake.icon"
        :aria="wake.detail"
        :tip="{ title: wake.label, tone: wake.tone === `warning` ? `warning` : undefined }"
        :dot="WAKE_DOT[wake.tone]"
        rail-key="tool:wake"
        @press="pressWake"
    />
</template>
