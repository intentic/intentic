<!-- The next update, downloading in the background: drawn where the update card's buttons stand until it is in, since
     there is nothing to press meanwhile. The step the machine is on, how far the pull has got when it measured that, and
     that the sandbox keeps working throughout. updateDownload.ts decides when this is drawn. -->
<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ProgressBar from "primevue/progressbar";
import { computed } from "vue";
import type { DownloadStep } from "./updateDownload";

const t = useT();

const { step, percent, version } = defineProps<{
    step: DownloadStep;
    /** 0–100 while pulling, when the machine measured one; absent draws a bar without an end. */
    percent?: number | undefined;
    /** The release on its way, as the card offers it. */
    version: string | undefined;
}>();

const ICON = { starting: `download`, download: `download`, build: `hammer`, check: `shield` } as const satisfies Record<DownloadStep, IconName>;

const headline = computed(() => {
    const said = { version: version ?? `` };
    switch (step) {
        case `starting`:
            return t(`sandbox.sandboxUpdateCard.downloadStarting`, said);
        case `build`:
            return t(`sandbox.sandboxUpdateCard.downloadBuilding`, said);
        case `check`:
            return t(`sandbox.sandboxUpdateCard.downloadChecking`, said);
        default:
            return t(`sandbox.sandboxUpdateCard.downloadPulling`, said);
    }
});
</script>

<template>
    <div class="flex flex-col gap-2.5 rounded-lg border border-line-subtle bg-canvas/40 p-3.5" role="status" aria-live="polite">
        <div class="flex items-center gap-2 text-xs">
            <Icon :name="ICON[step]" class="shrink-0 text-link" aria-hidden="true" />
            <span class="min-w-0 flex-1 font-medium text-content">{{ headline }}</span>
            <span v-if="percent !== undefined" class="shrink-0 font-mono text-2xs tabular-nums text-muted">{{ percent }}%</span>
        </div>
        <ProgressBar
            :value="percent ?? 0"
            :mode="percent === undefined ? `indeterminate` : `determinate`"
            :show-value="false"
            class="h-1.5"
            :aria-label="headline"
        />
        <p class="text-2xs text-subtle">{{ t(`sandbox.sandboxUpdateCard.downloadNote`) }}</p>
    </div>
</template>
