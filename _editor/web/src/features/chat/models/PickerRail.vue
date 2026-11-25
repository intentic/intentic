<script setup lang="ts">
import type { Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { accessStateFor } from "../../../models/providers/access";
import type { PickerLane } from "../../../models/conversations/accounts/modelPickerState";
import type { PickerSource } from "../../../models/conversations/accounts/pickerSource";
import { useSandboxVersion } from "../../../models/sandbox/useSandboxVersion";
import { degradedNote } from "../../../models/providers/capacity/degradedNote";
import ProviderLogo from "../../../parts/providers/ProviderLogo.vue";

// The model picker's provider strip (ModelPicker.vue). It filters, never switches: scoping to one provider is a safe
// glance, and switching only happens by picking a model row. `select` is the filter the reader asked for; the picker
// owns what follows it (focus back to the search).
const { lanes, rail, provider, source } = defineProps<{
    lanes: readonly PickerLane[];
    // The lane key the list is filtered to; undefined is every provider.
    rail: string | undefined;
    // The provider the conversation is on, which keeps its dot whatever the filter.
    provider: AgentProvider;
    // Who answers for the lanes: a sandbox's providers, or this computer's coding agents (pickerSource.ts).
    source: PickerSource;
}>();
const emit = defineEmits<{ select: [lane: string | undefined] }>();
const t = useT();

// A provider whose connected account can no longer be refreshed; badged so a broken credential isn't mistaken for a
// healthy one.
const needsReauth = (target: AgentProvider): boolean => accessStateFor(target).needsReauth;

// Whether this provider's runtime can serve a turn, from the daemon's background probe; distinct from the credential
// badges above. Silent unless sure; asked against the native harness, the axis a row would run on by default.
const { pairIssue } = useSandboxVersion();
// A sandbox's runtime alone: a coding agent of this computer is its own program, which the sandbox's probe never ran.
const runtimeIssue = (target: AgentProvider): string | undefined =>
    source.kind === `sandbox` ? pairIssue(capabilitiesOf(target, `native`).runtime, target) : undefined;

// The provider itself failing or throttling turns, as the daemon reports it: every account may read full of room while
// every turn on them fails, so a reader choosing where to run is told here, and when the sandbox tries it again.
const outage = (target: AgentProvider) => (source.kind === `sandbox` ? degradedNote(target) : undefined);

// What a lane stands on: its first provider; every other rail fact is an account fact. Ready means the reader can run
// it (connected, and theirs to spend), as the list's own order reads it.
const lead = (lane: PickerLane): AgentProvider => lane.providers[0]!;
const ready = (lane: PickerLane): boolean => lane.providers.some(source.runnable);
// What the lane's access says in words: not shared with the reader, else its price while not connected, or on this
// computer what the coding agent still needs.
const access = (lane: PickerLane): string | undefined => source.chip(lead(lane));
const active = (lane: PickerLane): boolean => lane.providers.includes(provider);

// The tooltip carries what the icon can't: whether this lane can run, and at what price. A card of facts for the pointer
// (a row drops out when it has nothing to say); the screen reader's name keeps the runtime's own sentence.
const tipOf = (lane: PickerLane): Tip => {
    const reauth = needsReauth(lead(lane));
    const runtimeDown = runtimeIssue(lead(lane)) !== undefined;
    const degraded = outage(lead(lane));
    return {
        title: lane.label,
        tone: runtimeDown || reauth || degraded !== undefined ? `warning` : undefined,
        rows: [
            { label: t(`chat.modelPicker.access`), value: access(lane) ?? `` },
            { label: t(`shared.account`), value: reauth ? t(`chat.words.reconnectNeeded`) : ``, tone: `warning` },
            { label: t(`chat.modelPicker.runtime`), value: runtimeDown ? t(`chat.modelPicker.unavailable`) : ``, tone: `danger` },
            { label: t(`chat.providerDegraded.label`), value: degraded?.short ?? ``, tone: `warning` },
        ],
        note: degraded?.retry ?? (active(lane) ? t(`shared.active`) : undefined),
    };
};
const labelOf = (lane: PickerLane): string =>
    [
        lane.label,
        ...(active(lane) ? [t(`shared.active`)] : []),
        ...(access(lane) !== undefined ? [access(lane)!] : []),
        ...(needsReauth(lead(lane)) ? [t(`chat.words.reconnectNeeded`)] : []),
        ...(runtimeIssue(lead(lane)) !== undefined ? [runtimeIssue(lead(lane))!] : []),
        ...(outage(lead(lane)) === undefined ? [] : [outage(lead(lane))!.line]),
    ].join(` · `);
</script>

<template>
    <div
        role="radiogroup"
        :aria-label="t(`chat.modelPicker.filterByProvider`)"
        class="flex w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-1.5 py-1.5"
    >
        <button
            type="button"
            role="radio"
            :aria-checked="rail === undefined"
            class="ui-row-select ui-row-select-horizontal flex h-8 w-8 shrink-0 items-center justify-center rounded-lg max-md:h-11 max-md:w-11"
            :class="{ 'ui-row-select-on': rail === undefined }"
            v-tooltip.bottom="t(`shared.allProviders`)"
            :aria-label="t(`shared.allProviders`)"
            @click="emit(`select`, undefined)"
        >
            <Icon name="th-large" class="text-sm" :class="rail === undefined ? 'text-accent' : 'text-subtle'" />
        </button>
        <div class="mx-0.5 my-auto h-5 w-px shrink-0 bg-line" aria-hidden="true"></div>
        <button
            v-for="lane in lanes"
            :key="lane.key"
            type="button"
            role="radio"
            :aria-checked="rail === lane.key"
            class="ui-row-select ui-row-select-horizontal relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg max-md:h-11 max-md:w-11"
            :class="{ 'ui-row-select-on': rail === lane.key }"
            v-tooltip.bottom="tipOf(lane)"
            :aria-label="labelOf(lane)"
            @click="emit(`select`, lane.key)"
        >
            <ProviderLogo :provider="lead(lane)" :class="[rail === lane.key ? 'text-accent' : 'text-subtle', { 'opacity-50': !ready(lane) }]" />
            <!-- The current provider's dot: independent of the filter selection; both must be legible at once. -->
            <span v-if="active(lane)" class="absolute right-1 top-1 h-1 w-1 rounded-full bg-primary-500" aria-hidden="true"></span>
            <!-- One corner, one fault, the one a person can act on first: a broken account, then the provider failing turns
                 (which waiting answers), then a lane not theirs to run. A provider with a broken account has an account,
                 so it is never the locked one. -->
            <Icon v-if="needsReauth(lead(lane))" name="exclamation-triangle" class="absolute bottom-0.5 right-0.5 text-[0.5rem] text-warning" aria-hidden="true" />
            <Icon v-else-if="outage(lead(lane)) !== undefined" name="clock" class="absolute bottom-0.5 right-0.5 text-[0.5rem] text-warning" aria-hidden="true" />
            <Icon v-else-if="!ready(lane)" name="lock" class="absolute bottom-0.5 right-0.5 text-[0.5rem] text-subtle" aria-hidden="true" />
        </button>
    </div>
</template>
