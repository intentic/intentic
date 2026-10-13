<!-- The loop axis: one chip per loop the daemon offers this provider on, the default's first. Picks, never applies (prop in, event out). -->
<script setup lang="ts">
import { computed } from "vue";
import { type AgentHarness, type AgentLoop, type AgentProvider, capabilitiesOf, loopLabel, providerLoops, termsOf } from "@intentic/sandbox-contract";
import { useT } from "@intentic/ui/i18n";
import { providerDisplayLabel } from "../accounts/providerCatalog";
import { harnessOfLoop, offeredLoops, selectedLoop } from "./offeredLoops";
import LoopTermsHint from "./LoopTermsHint.vue";
import { useSandboxVersion } from "../../sandbox/overview/version/useSandboxVersion";

const t = useT();

const emit = defineEmits<{ select: [AgentHarness] }>();
const { provider, harness, disabled = false } = defineProps<{ provider: AgentProvider; harness: AgentHarness; disabled?: boolean }>();

const offered = computed(() => offeredLoops(provider));
const selected = computed(() => selectedLoop(offered.value, harness));

// An installed agent's own loop goes by the name it was installed under, which only the shell knows; a provider's own CLI
// loop (Grok Build, Kimi CLI) by the program's name, which the contract carries.
const labelOf = (loop: AgentLoop): string =>
    loop === `vendor` && providerLoops(provider).offered.vendor?.label === undefined ? providerDisplayLabel(provider) : loopLabel(provider, loop);

// A loop hosting this provider on a route that can't serve it now (a sign-in that loop needs and nobody made, an endpoint
// the loop can't speak to) says so on its chip, in the daemon's own sentence, before a turn is sent to find out.
const { pairIssue } = useSandboxVersion();

const chips = computed(() =>
    offered.value.map((loop) => ({
        loop,
        label: labelOf(loop),
        terms: termsOf(provider, loop),
        harness: harnessOfLoop(offered.value, loop),
        issue: pairIssue(capabilitiesOf(provider, loop).runtime, provider),
    })),
);
</script>

<template>
    <!-- Drawn only where there is a choice; a lone chip would be a label pretending to be a control. -->
    <div v-if="offered.length > 1" class="flex items-center justify-between gap-2">
        <span class="text-2xs font-medium uppercase tracking-wide text-muted">{{ t(`shared.harness`) }}</span>
        <div class="flex flex-wrap items-center justify-end gap-1">
            <span v-for="chip in chips" :key="chip.loop" class="inline-flex items-center gap-1">
                <button
                    type="button"
                    class="composer-ghost ui-off h-7 gap-1 px-2.5 text-2xs font-medium max-md:h-10"
                    :class="{ 'composer-active': selected === chip.loop, 'text-muted line-through decoration-dotted': chip.issue !== undefined }"
                    :disabled="disabled"
                    :aria-pressed="selected === chip.loop"
                    :title="chip.issue"
                    :aria-description="chip.issue"
                    @click="emit(`select`, chip.harness)"
                >
                    {{ chip.label }}
                </button>
                <!-- Beside the chip, not in it: the hint takes focus of its own, and a button may not hold another control. -->
                <LoopTermsHint v-if="chip.terms !== undefined" :terms="chip.terms" class="text-2xs" />
            </span>
        </div>
    </div>
</template>
