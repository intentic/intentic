<script setup lang="ts">
import type { CapabilityProbe } from "@intentic/sandbox-contract/schemas/capabilities";
import { toneTint } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import WaitProgress from "../../components/WaitProgress.vue";
import { useWaitClock } from "../../components/useWaitClock";

// What stands above a tile's Save: what its test said, since "will this work" belongs before the commitment, and the
// save or the test still running, with how long it has run. A save that installs something runs for minutes, its
// commands in a terminal of their own, and a bare spinner on Save read as a hang.

const { probeResult, submitStartedAt, probeStartedAt } = defineProps<{
    readonly probeResult: CapabilityProbe | undefined;
    // When the save or the test still running began (capabilitySubmit.ts, capabilityProbe.ts); undefined when none runs.
    readonly submitStartedAt: number | undefined;
    readonly probeStartedAt: number | undefined;
}>();

const t = useT();

const wait = useWaitClock(() => submitStartedAt ?? probeStartedAt);
const what = computed(() => (submitStartedAt !== undefined ? t(`capabilities.capabilities.savingWhat`) : t(`capabilities.capabilities.testingWhat`)));
</script>

<template>
    <p
        v-if="probeResult"
        class="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
        :class="
            probeResult.ok
                ? toneTint(`success`, `strong`, `text-content`)
                : probeResult.checked
                  ? toneTint(`danger`, `strong`, `text-content`)
                  : `border-line bg-card text-muted`
        "
    >
        <Icon
            :name="probeResult.ok ? 'check-circle' : probeResult.checked ? 'exclamation-triangle' : 'info-circle'"
            class="shrink-0 text-2xs"
            :class="probeResult.ok ? 'text-success' : probeResult.checked ? 'text-danger' : 'text-subtle'"
        />
        {{ probeResult.message }}
    </p>
    <WaitProgress v-if="wait" :wait="wait" :what="what" />
</template>
