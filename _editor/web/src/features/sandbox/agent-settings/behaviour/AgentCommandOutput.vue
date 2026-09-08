<script setup lang="ts">
import { formatTokens, Row, RowGroup, Verdict } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { relativeTime } from "../../../chat/models/catalog";
import { useSavings } from "../../usage/useSavings";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { ALL_CLEANER_IDS, CLEANER_OPTIONS, savedByCleaner } from "../../usage/savingsChart";
import { asPercent } from "../models/numberInputs";
import CommandOutputInfo from "./CommandOutputInfo.vue";
import MeasurementPanel, { type PanelReading } from "../models/MeasurementPanel.vue";

// Shell-output filter: master toggle, per-cleaner checklist, measurement holdout, and realized savings, as one
// grouped section rather than a card per toggle.

const { settings, patch } = useSandboxSettings();
const { savings } = useSavings({});

// `outputCleaners` is a spec string (`` = all, `off` = disabled); finer specs come from the checklist below.
const cleaningOn = computed(() => (settings.value?.outputCleaners ?? ``) !== `off`);

// Cleaner ids/labels live in savingsChart.ts, shared with the Usage tab's segments; names must match. Checklist
// round-trips through the same `outputCleaners` spec string the daemon reads.

// Mirrors bin/cleaners.mjs's parseCleaners: `` = all on, an allow-list ("git,pnpm") = only those, `-cap` = all
// except those, `off` = none.
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

// Emits the shortest spec for `enabled`: `` (all), an allow-list, or a default-minus form.
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

// Percentage [0,100] of commands whose output bypasses cleaning, stored as a fraction [0,1].
const holdoutPercent = computed<number>(() => asPercent(settings.value?.outputHoldout));

// Not through `verdictsOf`: this experiment compares whole commands as a share, not turn-level means. No
// reading until `measuredSavedPct` exists, since an early "0%" would look like a measurement rather than a gap.
const cleanerReadings = computed<PanelReading[]>(() => {
    const holdout = savings.value?.input.holdout;
    if (holdout?.measuredSavedPct === undefined) {
        return [];
    }
    return [
        {
            verdict: {
                value: `${holdout.measuredSavedPct}%`,
                unit: `of command output removed`,
                // Only the measured figure earns `success`; the estimate above it stays muted.
                tone: holdout.measuredSavedPct > 0 ? `success` : `muted`,
                detail: `cleaned commands against the raw ones the holdout kept`,
            },
            on: holdout.cleaned,
            off: holdout.heldOut,
        },
    ];
});

// All-time estimate across every cleaned command, vs. the holdout's measured slice. Lives in a `Verdict` slot,
// not the row `#description`, since a description is static text and this carries a live figure and freshness.
const savingsVerdict = computed(() => {
    const input = savings.value?.input;
    if (input === undefined || input.commands === 0) {
        return {
            value: `Nothing yet`,
            unit: `no commands cleaned so far`,
            tone: `muted`,
            detail: `The ledger fills as the assistant runs shell commands, one row per command.`,
            evidence: ``,
        } as const;
    }
    const measured = input.holdout.measuredSavedPct;
    return {
        value: `${input.savedPct}%`,
        unit: `of command output removed, all time`,
        tone: `success`,
        detail: `~${formatTokens(input.rawTokens)} → ~${formatTokens(input.emittedTokens)} tokens over ${input.commands} commands${
            measured === undefined ? `` : ` · ${measured}% measured against the holdout`
        }`,
        evidence: input.updatedAt === undefined ? `` : `last command ${relativeTime(input.updatedAt)}`,
    } as const;
});

// Per-cleaner value, all time and unwindowed; the Usage tab's Savings section owns the windowed comparison.
const savedTokens = computed(() => savedByCleaner(savings.value?.input));
</script>

<template>
    <RowGroup label="Command output">
        <template #info><CommandOutputInfo /></template>
        <Row
            spine
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
            <!-- Per-cleaner checklist; shown only while cleaning is on. -->
            <template v-if="settings !== undefined && cleaningOn" #below>
                <div class="flex flex-col gap-2">
                    <div class="flex items-baseline justify-between gap-2">
                        <p class="text-2xs font-medium uppercase tracking-wide text-subtle">Cleaners</p>
                        <!-- Per-switch savings turn sixteen identical toggles into a list you can prune by impact. -->
                        <p class="text-2xs text-subtle">tokens saved, all time</p>
                    </div>
                    <div class="grid grid-cols-2 gap-x-4 gap-y-1.5">
                        <label v-for="cleaner in CLEANER_OPTIONS" :key="cleaner.id" class="flex items-center justify-between gap-2">
                            <span class="flex min-w-0 items-baseline gap-1.5">
                                <span class="truncate text-xs text-content">{{ cleaner.label }}</span>
                                <!-- Absent means not yet measured, a different claim from zero. -->
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

                    <!-- Leaves a share of commands raw so savings are measured against a real baseline, not just estimated. -->
                    <!-- Extra top margin here: what sits above is a grid of switches, not a short description, so it needs more separation. -->
                    <MeasurementPanel
                        class="mt-3"
                        :percent="holdoutPercent"
                        :readings="cleanerReadings"
                        note="Leaves this share of commands uncleaned, as a control."
                        on-label="cleaned"
                        off-label="raw"
                        @commit="(outputHoldout: number) => patch({ outputHoldout })"
                    />
                </div>
            </template>
        </Row>

        <!--
            Hero figure with freshness and context under it, not run-on prose; the per-mechanism breakdown lives on the
            Usage tab. Rendered as a `Verdict` in `#below`, not `#description`, so absence ("Nothing yet") reads as a state.
        -->
        <Row spine icon="wave-pulse" title="Output savings">
            <template #below>
                <div class="flex flex-col gap-3">
                    <Verdict
                        :value="savingsVerdict.value"
                        :unit="savingsVerdict.unit"
                        :tone="savingsVerdict.tone"
                        :detail="savingsVerdict.detail"
                        :evidence="savingsVerdict.evidence"
                    />
                    <!--
                        Grouped by command and ranked by total, answering "what deserves a handler" rather than "biggest single run";
                        the count shows because cost across many runs is what justifies writing one.
                    -->
                    <div v-if="savings !== undefined && savings.input.gaps.length > 0" class="flex flex-col gap-1">
                        <p class="text-2xs font-medium uppercase tracking-wide text-subtle">Un-cleaned (add a handler)</p>
                        <p v-for="gap in savings.input.gaps.slice(0, 5)" :key="gap.command" class="flex items-baseline gap-1.5 text-2xs">
                            <span class="shrink-0 tabular-nums text-muted">~{{ formatTokens(gap.tokens) }}</span>
                            <span class="shrink-0 tabular-nums text-subtle">×{{ gap.commands }}</span>
                            <span class="truncate font-mono text-muted">{{ gap.command }}</span>
                        </p>
                    </div>
                </div>
            </template>
        </Row>
    </RowGroup>
</template>
