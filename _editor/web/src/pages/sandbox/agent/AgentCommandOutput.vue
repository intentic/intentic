<script setup lang="ts">
import { ui, formatTokens, Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { relativeTime } from "../../../composables/chat/catalog";
import { useSavings } from "../../../composables/sandbox/useSavings";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { ALL_CLEANER_IDS, CLEANER_OPTIONS, savedByCleaner } from "../savingsChart";
import { asPercent, commitPercent } from "./numberInputs";
import CommandOutputInfo from "./CommandOutputInfo.vue";

/* The shell-output filter: the master toggle, the per-cleaner checklist the spec string round-trips through,
 * the holdout that measures it, and what it has all been worth. One grouped section instead of a card per
 * toggle. */

const { settings, patch } = useSandboxSettings();
const { savings } = useSavings({});

// Output cleaning is a spec string ("" = all cleaners on, "off" = disabled), not a bool; this toggle covers the
// common on/off. A finer spec (e.g. "-cap", "git,pnpm") is expressed by the checklist below.
const cleaningOn = computed(() => (settings.value?.outputCleaners ?? ``) !== `off`);

// --- Per-cleaner toggles (the `outputCleaners` spec, edited as a checklist) ---------------------------------
// The id + label list lives in savingsChart.ts, next to the projections that draw the same mechanisms on the
// Usage tab: a switch here and a segment there must never end up named two different things. Each entry renders
// one switch; the checklist round-trips through the spec string the daemon already threads to the filter, so
// every cleaner is individually A/B-benchmarkable without touching the settings JSON by hand.

// Which cleaners the current spec enables (mirrors bin/cleaners.mjs parseCleaners, lenient): "" = all on, an
// allow-list ("git,pnpm") = only those, default-minus ("-cap") = all except. "off" (master off) = none.
const enabledCleaners = computed<Set<string>>(() => {
    const spec = settings.value?.outputCleaners ?? ``;
    if (spec === `off`) {
        return new Set();
    }
    const tokens = spec
        .split(`,`)
        .map((token) => token.trim())
        .filter((token) => token !== `` && ALL_CLEANER_IDS.includes(token.replace(/^-/, ``)));
    if (tokens.length === 0) {
        return new Set(ALL_CLEANER_IDS);
    }
    if (tokens.some((token) => !token.startsWith(`-`))) {
        return new Set(tokens.filter((token) => !token.startsWith(`-`)));
    }
    const disabled = new Set(tokens.map((token) => token.slice(1)));
    return new Set(ALL_CLEANER_IDS.filter((id) => !disabled.has(id)));
});

// Emit the shortest spec that expresses `enabled`: "" (all), the allow-list, or the default-minus form.
const specFromEnabled = (enabled: Set<string>): string => {
    const disabled = ALL_CLEANER_IDS.filter((id) => !enabled.has(id));
    if (disabled.length === 0) {
        return ``;
    }
    if (enabled.size === 0) {
        return `off`;
    }
    return disabled.length <= enabled.size ? disabled.map((id) => `-${id}`).join(`,`) : [...enabled].join(`,`);
};

const toggleCleaner = (id: string, on: boolean): void => {
    const enabled = new Set(enabledCleaners.value);
    if (on) {
        enabled.add(id);
    } else {
        enabled.delete(id);
    }
    patch({ outputCleaners: specFromEnabled(enabled) });
};

// Holdout control: a percentage [0,100] of commands whose output bypasses cleaning, stored as a fraction [0,1].
const holdoutPercent = computed<number>(() => asPercent(settings.value?.outputHoldout));

/* What each mechanism has been worth, all-time: the readout that belongs NEXT TO ITS SWITCH. Unwindowed on
 * purpose: this page is where a switch is flipped, not where a period is compared, and the Usage tab's Savings
 * section owns the windowed chart. */
const savedTokens = computed(() => savedByCleaner(savings.value?.input));
</script>

<template>
    <RowGroup label="Command output">
        <template #info><CommandOutputInfo /></template>
        <Row
            icon="bolt"
            title="Clean command output"
            description="Trim noisy shell output before it reaches the assistant."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="cleaningOn"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ outputCleaners: value ? `` : `off` })"
                />
            </template>
            <!-- Per-cleaner switches (the spec, as a checklist): only meaningful while cleaning is on. -->
            <template v-if="settings !== undefined && cleaningOn" #below>
                <div class="flex flex-col gap-2">
                    <div class="flex items-baseline justify-between gap-2">
                        <p class="text-2xs font-medium uppercase tracking-wide text-subtle">Cleaners</p>
                        <!-- What each switch is WORTH, all-time, next to the switch itself. This is the tuning
                             job: sixteen identical toggles are a wall, sixteen toggles carrying their own
                             savings are a ranked list you can prune. -->
                        <p class="text-2xs text-subtle">tokens saved, all time</p>
                    </div>
                    <div class="grid grid-cols-2 gap-x-4 gap-y-1.5">
                        <label v-for="cleaner in CLEANER_OPTIONS" :key="cleaner.id" class="flex items-center justify-between gap-2">
                            <span class="flex min-w-0 items-baseline gap-1.5">
                                <span class="truncate text-xs text-content">{{ cleaner.label }}</span>
                                <!-- A cleaner with nothing recorded says nothing rather than "0": it has not
                                     been measured, which is a different claim from "worth nothing". -->
                                <span v-if="savedTokens.get(cleaner.id) !== undefined" class="shrink-0 text-2xs tabular-nums text-success">
                                    ~{{ formatTokens(savedTokens.get(cleaner.id) ?? 0) }}
                                </span>
                            </span>
                            <ToggleSwitch
                                :model-value="enabledCleaners.has(cleaner.id)"
                                @update:model-value="(value: boolean) => toggleCleaner(cleaner.id, value)"
                            />
                        </label>
                    </div>

                    <!-- Holdout: measurement control, a % of commands left raw so the savings report has a real
                         cleaned-vs-raw baseline instead of an estimate. -->
                    <label class="mt-3 flex items-center justify-between gap-3">
                        <span class="flex min-w-0 flex-col">
                            <span class="text-xs text-content">Holdout control</span>
                            <span class="text-2xs text-muted">Leave this % of commands uncleaned to measure real savings.</span>
                        </span>
                        <span class="flex shrink-0 items-center gap-1">
                            <input
                                type="number"
                                min="0"
                                max="100"
                                :value="holdoutPercent"
                                :class="ui.inputSm('w-16 text-right')"
                                @change="(event: Event) => commitPercent(event, holdoutPercent, (outputHoldout: number) => patch({ outputHoldout }))"
                            />
                            <span class="text-xs text-muted">%</span>
                        </span>
                    </label>
                </div>
            </template>
        </Row>

        <!-- Realized savings. The hero is one number; everything that qualifies it: freshness, what it is a
             share of: sits under it rather than trailing it as a run-on, because those are the facts that tell
             a live figure from a frozen one, and this card once sat on a ledger nothing was writing any more.
             The breakdown BY mechanism lives on the Usage tab, where a window exists to compare it over. -->
        <Row icon="wave-pulse" title="Output savings">
            <template #description>
                <template v-if="savings !== undefined && savings.input.commands > 0">
                    <span class="font-medium text-success">{{ savings.input.savedPct }}% saved</span>
                    · ~{{ formatTokens(savings.input.rawTokens) }} → ~{{ formatTokens(savings.input.emittedTokens) }} tokens over
                    {{ savings.input.commands }} commands
                    <span v-if="savings.input.holdout.measuredSavedPct !== undefined">
                        · <span class="text-content">{{ savings.input.holdout.measuredSavedPct }}%</span> measured against the holdout
                    </span>
                    <br />
                    <span v-if="savings.input.updatedAt !== undefined" class="text-muted">
                        last command {{ relativeTime(savings.input.updatedAt) }}
                    </span>
                </template>
                <!-- Absence used to be the empty state: the row simply wasn't rendered, so a page of switches
                     promising savings showed nothing at all about them. -->
                <span v-else class="text-muted">
                    Nothing measured yet: the ledger fills as the agent runs shell commands, one row per command.
                </span>
            </template>
            <!-- WHERE THE NEXT CLEANER WOULD PAY. Grouped by command and ranked by total, so the list answers
                 "what is worth a handler" rather than "which single run was biggest", and the count is shown
                 because a command that costs this much across twenty runs is the one to write for. -->
            <template v-if="savings !== undefined && savings.input.gaps.length > 0" #below>
                <div class="flex flex-col gap-1">
                    <p class="text-2xs font-medium uppercase tracking-wide text-subtle">Un-cleaned (add a handler)</p>
                    <p v-for="gap in savings.input.gaps.slice(0, 5)" :key="gap.command" class="flex items-baseline gap-1.5 text-2xs">
                        <span class="shrink-0 tabular-nums text-muted">~{{ formatTokens(gap.tokens) }}</span>
                        <span class="shrink-0 tabular-nums text-subtle">×{{ gap.commands }}</span>
                        <span class="truncate font-mono text-muted">{{ gap.command }}</span>
                    </p>
                </div>
            </template>
        </Row>
    </RowGroup>
</template>
