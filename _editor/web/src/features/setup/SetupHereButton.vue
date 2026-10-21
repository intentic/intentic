<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { AppStopApi } from "./flow/useAppStop";

// "SET IT UP NOW", the app's button, on one row with its caption rather than under a sentence of its own. While the
// app's install runs, its Cancel takes the caption's place, so a misclick costs one more click rather than a Docker
// install (flow/useAppStop.ts), and the stop is said under the button it handed back.

const { app } = defineProps<{ app: Pick<AppStopApi, `installUnderWay` | `stoppable` | `stopped` | `start` | `stop`> }>();
const t = useT();
</script>

<template>
    <div class="flex flex-col gap-2">
        <div class="flex flex-col items-stretch gap-x-4 gap-y-2 md:flex-row md:items-center">
            <Button
                :label="t(`setup.setup.setUpNow`)"
                class="w-full shrink-0 justify-center md:w-fit"
                :loading="app.installUnderWay.value"
                :disabled="app.installUnderWay.value"
                @click="app.start"
            >
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <Button v-if="app.stoppable.value" :label="t(`ui.action.cancel`)" tier="quiet" class="self-center" data-setup-stop @click="app.stop">
                <template #icon><Icon name="times" /></template>
            </Button>
            <p v-else class="min-w-0 text-xs text-muted">{{ t(`setup.setup.installsDockerNeedStarts`) }}</p>
        </div>
        <p v-if="app.stopped.value" class="flex items-center gap-2 text-xs text-muted" data-setup-stopped>
            <Icon name="stop" class="shrink-0 text-subtle" />
            <span class="min-w-0">{{ t(`setup.setup.stoppedHere`) }}</span>
        </p>
    </div>
</template>
