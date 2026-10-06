<script setup lang="ts">
import { formatTokens, Notice, Row, RowGroup, RowNote, timeAgo, Verdict } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useSavings } from "../../usage/useSavings";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { allCleanerIds, cleanerOptions, savedByCleaner } from "../../usage/savingsChart";
import { asPercent } from "../models/numberInputs";
import MeasurementPanel from "../models/MeasurementPanel.vue";
import { type ResultTable, tableOf } from "../models/experimentReadings";
import { useT } from "@intentic/ui/i18n";

// Shell-output filter: master toggle, per-cleaner checklist, measurement holdout, and realized savings, as one
// grouped section rather than a card per toggle.

const t = useT();

const { settings, patch, refusal } = useSandboxSettings();
const { savings } = useSavings({});

// Whole conversations again: a result the gateway replaced stays replaced for the rest of the session.
const clearingHoldoutPercent = computed<number>(() => asPercent(settings.value?.toolResultClearingHoldout));
const clearingTable = computed<ResultTable | undefined>(() => tableOf(savings.value?.clearing));

// `outputCleaners` is a spec string (`` = all, `off` = disabled); finer specs come from the checklist below.
const cleaningOn = computed(() => (settings.value?.outputCleaners ?? ``) !== `off`);

// Cleaner ids/labels live in savingsChart.ts, shared with the Usage tab's segments; names must match. Checklist
// round-trips through the same `outputCleaners` spec string the daemon reads.

// Mirrors @intentic/output-cleaners' parseCleaners: `` = all on, an allow-list ("git,pnpm") = only those, `-cap` = all
// except those, `off` = none.
const enabledCleaners = computed<Set<string>>(() => {
    const spec = settings.value?.outputCleaners ?? ``;
    if (spec === `off`) {
        return new Set();
    }
    const tokens = spec
        .split(`,`)
        .map((token) => token.trim())
        .filter((token) => token !== `` && allCleanerIds().includes(token.replace(/^-/, ``)));
    if (tokens.length === 0) {
        return new Set(allCleanerIds());
    }
    if (tokens.some((token) => !token.startsWith(`-`))) {
        return new Set(tokens.filter((token) => !token.startsWith(`-`)));
    }
    const disabled = new Set(tokens.map((token) => token.slice(1)));
    return new Set(allCleanerIds().filter((id) => !disabled.has(id)));
});

// Emits the shortest spec for `enabled`: `` (all), an allow-list, or a default-minus form.
const specFromEnabled = (enabled: Set<string>): string => {
    const disabled = allCleanerIds().filter((id) => !enabled.has(id));
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

// Not through `tableOf`: this experiment compares whole commands as a share, not turn-level means, so its one row has
// no averages and its change is already the measured share. No table until `measuredSavedPct` exists, since an early
// "0%" would look like a measurement rather than a gap.
const cleanerTable = computed<ResultTable | undefined>(() => {
    const holdout = savings.value?.input.holdout;
    if (holdout?.measuredSavedPct === undefined) {
        return undefined;
    }
    const pct = Math.round(holdout.measuredSavedPct);
    return {
        unit: `commands`,
        on: holdout.cleaned,
        off: holdout.heldOut,
        rows: [{ key: `outputReached`, outcome: pct > 0 ? { kind: `lower`, pct } : { kind: `unclear` } }],
    };
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
            detail: t(`sandbox.agentCommandOutput.ledgerFillsAssistantRuns`),
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
        evidence: input.updatedAt === undefined ? `` : `last command ${timeAgo(input.updatedAt, { days: true })}`,
    } as const;
});

// Per-cleaner value, all time and unwindowed; the Usage tab's Savings section owns the windowed comparison.
const savedTokens = computed(() => savedByCleaner(savings.value?.input));
</script>

<template>
    <RowGroup :label="t(`sandbox.agentCommandOutput.commandOutput`)">
        <Row
            spine
            icon="bolt"
            :title="t(`sandbox.agentCommandOutput.cleanCommandOutput`)"
            :description="t(`sandbox.agentCommandOutput.trimNoisyShellOutput`)"
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
                        <p class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`sandbox.agentCommandOutput.cleaners`) }}</p>
                        <!-- Per-switch savings turn sixteen identical toggles into a list you can prune by impact. -->
                        <p class="text-2xs text-subtle">{{ t(`sandbox.agentCommandOutput.tokensSavedAllTime`) }}</p>
                    </div>
                    <div class="grid grid-cols-2 gap-x-4 gap-y-1.5">
                        <label v-for="cleaner in cleanerOptions()" :key="cleaner.id" class="flex items-center justify-between gap-2">
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
                    <!-- Extra margin separates output from the switch grid above. -->
                    <MeasurementPanel
                        class="mt-3"
                        :percent="holdoutPercent"
                        :table="cleanerTable"
                        :note="t(`sandbox.agentCommandOutput.ofCommandsRunUncleaned`)"
                        :on-label="t(`sandbox.agentCommandOutput.cleaned`)"
                        :off-label="t(`sandbox.agentCommandOutput.raw`)"
                        @commit="(outputHoldout: number) => patch({ outputHoldout })"
                    />
                </div>
            </template>
        </Row>

        <!-- What stays in the conversation after it ran, where the row above is what reaches it: the gateway in front of
             a Claude turn replaces old tool results a chunk at a time, measured on the prompt each call carries. -->
        <Row
            spine
            icon="compress"
            :title="t(`sandbox.agentCommandOutput.clearOldResults`)"
            :description="t(`sandbox.agentCommandOutput.clearOldResultsDescription`)"
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.toolResultClearing ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ toolResultClearing: value })"
                />
            </template>
            <template v-if="settings?.toolResultClearing === true" #below>
                <MeasurementPanel
                    :table="clearingTable"
                    :percent="clearingHoldoutPercent"
                    :note="t(`sandbox.agentCommandOutput.ofConversationsKeepEveryResult`)"
                    :on-label="t(`sandbox.agentCommandOutput.clearedResults`)"
                    :off-label="t(`sandbox.measurementPanel.without`)"
                    @commit="(toolResultClearingHoldout: number) => patch({ toolResultClearingHoldout })"
                />
            </template>
        </Row>

        <!-- Hero figure with freshness and context under it, not run-on prose; the per-mechanism breakdown lives on the Usage tab. -->
        <Row spine icon="wave-pulse" :title="t(`sandbox.agentCommandOutput.outputSavings`)">
            <template #below>
                <div class="flex flex-col gap-3">
                    <Verdict
                        :value="savingsVerdict.value"
                        :unit="savingsVerdict.unit"
                        :tone="savingsVerdict.tone"
                        :detail="savingsVerdict.detail"
                        :evidence="savingsVerdict.evidence"
                    />
                    <!-- Savings are grouped by command and ranked by total. -->
                    <div v-if="savings !== undefined && savings.input.gaps.length > 0" class="flex flex-col gap-1">
                        <div class="flex items-baseline justify-between gap-2">
                            <p class="text-2xs font-medium uppercase tracking-wide text-subtle">
                                {{ t(`sandbox.agentCommandOutput.unCleanedAddHandler`) }}
                            </p>
                            <p class="text-2xs text-subtle">{{ t(`sandbox.agentCommandOutput.tokensStillReachingAssistant`) }}</p>
                        </div>
                        <p v-for="gap in savings.input.gaps.slice(0, 5)" :key="gap.command" class="flex items-baseline gap-1.5 text-2xs">
                            <span class="shrink-0 tabular-nums text-muted">~{{ formatTokens(gap.tokens) }}</span>
                            <span class="shrink-0 tabular-nums text-subtle">×{{ gap.commands }}</span>
                            <span class="truncate font-mono text-muted">{{ gap.command }}</span>
                        </p>
                    </div>
                </div>
            </template>
        </Row>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
