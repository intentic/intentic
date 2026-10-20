<!-- The loop axis, as the toolbar's left end: one segment per loop the daemon offers this provider on (the default's first),
     or the loop's plain name where there is no choice, and beside it one ⓘ for what the picked loop costs (LoopHint). No
     label: the loop names say what they are, and the toolbar's words are the controls' own. Picks, never applies. -->
<script setup lang="ts">
import { computed } from "vue";
import type { AgentHarness, AgentLoop, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { capabilitiesOf, loopLabel, providerLoops, termsOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { type IconName, SegmentedControl, type TooltipValue } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { providerDisplayLabel } from "../../../models/providers/providerCatalog";
import { harnessOfLoop, offeredLoops, selectedLoop } from "../../../models/providers/offeredLoops";
import LoopHint from "./LoopHint.vue";
import { useSandboxVersion } from "../../../models/sandbox/useSandboxVersion";

const t = useT();

const emit = defineEmits<{ select: [AgentHarness] }>();
const {
    provider,
    harness,
    disabled = false,
    choosable = true,
} = defineProps<{
    provider: AgentProvider;
    harness: AgentHarness;
    // Locked for now (a turn is running on it): drawn, not pressable.
    disabled?: boolean;
    // False where the loop is not this surface's to change (another box's session): names it, offers nothing.
    choosable?: boolean;
}>();

const offered = computed(() => offeredLoops(provider));
const selected = computed(() => selectedLoop(offered.value, harness));

// An installed agent's own loop goes by the name it was installed under, which only the shell knows; a provider's own CLI
// loop (Grok Build, Kimi CLI) by the program's name, which the contract carries.
const labelOf = (loop: AgentLoop): string =>
    loop === `vendor` && providerLoops(provider).offered.vendor?.label === undefined ? providerDisplayLabel(provider) : loopLabel(provider, loop);

// A loop hosting this provider on a route that can't serve it now (a sign-in that loop needs and nobody made, an endpoint
// the loop can't speak to) says so on its segment, in the daemon's own sentence, before a turn is sent to find out.
const { pairIssue } = useSandboxVersion();

interface Segment {
    value: AgentLoop;
    label: string;
    title: TooltipValue;
    mark?: IconName;
    markTitle?: TooltipValue;
}

// The vendor's terms ride on each segment's hover, so they can be read before the press; once picked, the caveat line
// under the row says them for the loop in use, where a touch screen reaches them too.
const options = computed(() =>
    offered.value.map((loop) => {
        const terms = termsOf(provider, loop);
        const option: Segment = {
            value: loop,
            label: labelOf(loop),
            title: terms === undefined ? undefined : { title: t(`chat.words.vendorTerms`), quote: terms.note },
        };
        const issue = pairIssue(capabilitiesOf(provider, loop).runtime, provider);
        if (issue !== undefined) {
            option.mark = `exclamation-triangle`;
            option.markTitle = issue;
        }
        return option;
    }),
);

const pick = computed<AgentLoop>({
    get: () => selected.value,
    set: (loop) => emit(`select`, harnessOfLoop(offered.value, loop)),
});

// A choice draws the control; otherwise the loop is named, since a lone segment would be a label pretending to be a control.
const segmented = computed(() => choosable && offered.value.length > 1);
</script>

<template>
    <span class="flex min-w-0 items-center gap-1.5">
        <!-- A disabled fieldset disables every segment inside it natively, and dims them as one control. -->
        <fieldset v-if="segmented" class="min-w-0" :class="{ 'opacity-50': disabled }" :disabled="disabled">
            <SegmentedControl v-model="pick" :options="options" size="xs" :aria-label="t(`shared.harness`)" />
        </fieldset>
        <span v-else class="truncate text-2xs text-muted" v-tooltip.top="t(`shared.harness`)">{{ labelOf(selected) }}</span>
        <LoopHint :provider="provider" :harness="harness" />
    </span>
</template>
