<script setup lang="ts">
import { formatTokens, Icon, Notice, Row, RowGroup, RowNote, timeAgo, Verdict } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useSavings } from "../../usage/useSavings";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";
import { allCleanerIds, cleanerOptions, savedByCleaner } from "../../usage/savingsChart";
import { asPercent } from "../models/numberInputs";
import MeasurementPanel from "../models/MeasurementPanel.vue";
import type { ResultTable } from "../models/experimentReadings";
import { useT } from "@intentic/ui/i18n";

// Shell-output filter as one switch. What it saved sits under it; the per-cleaner switches, the commands no cleaner
// covers and the measurement holdout are tuning, so they fold away under "Advanced" with their state said on the fold.

const t = useT();

const { settings, patch, refusal } = useSandboxSettings();
const { savings } = useSavings({});

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

// What the switch has bought, said under the switch itself: one figure, then one line of what it stands on. The
// per-mechanism breakdown is the Usage tab's, a link away, so this does not grow a second card for it.
// Undefined while the report loads, so "nothing yet" never flashes up in front of a figure that exists.
const summary = computed(() => {
    const input = savings.value?.input;
    if (input === undefined) {
        return undefined;
    }
    if (input.commands === 0) {
        return {
            value: t(`sandbox.agentCommandOutput.nothingYet`),
            unit: t(`sandbox.agentCommandOutput.noCommandsCleaned`),
            tone: `muted`,
            detail: t(`sandbox.agentCommandOutput.ledgerFillsAssistantRuns`),
            measured: false,
        } as const;
    }
    const measured = input.holdout.measuredSavedPct;
    const detail = [
        t(
            `sandbox.agentCommandOutput.tokensOverCommands`,
            { raw: formatTokens(input.rawTokens), emitted: formatTokens(input.emittedTokens), count: input.commands },
            input.commands,
        ),
        measured === undefined ? undefined : t(`sandbox.agentCommandOutput.measuredAgainstHoldout`, { pct: measured }),
        input.updatedAt === undefined ? undefined : t(`sandbox.agentCommandOutput.lastCommand`, { ago: timeAgo(input.updatedAt, { days: true }) }),
    ]
        .filter((part) => part !== undefined)
        .join(` · `);
    return { value: `${input.savedPct}%`, unit: t(`sandbox.agentCommandOutput.ofOutputRemoved`), tone: `success`, detail, measured: true } as const;
});

// Said on the fold's own line, so a cleaner switched off or a share of commands left raw is never hidden by closing it.
const advancedFacts = computed<string[]>(() => {
    const total = allCleanerIds().length;
    const on = enabledCleaners.value.size;
    return [
        on === total ? t(`sandbox.agentCommandOutput.allCleanersOn`, { total }) : t(`sandbox.agentCommandOutput.someCleanersOn`, { on, total }),
        ...(holdoutPercent.value > 0 ? [t(`sandbox.agentCommandOutput.heldOutForComparison`, { pct: holdoutPercent.value })] : []),
    ];
});

// Per-cleaner value, all time and unwindowed; the Usage tab's Savings section owns the windowed comparison.
const savedTokens = computed(() => savedByCleaner(savings.value?.input));

// The commands no cleaner matched, biggest first: where a new cleaner would pay. One line, the run count a hover away.
const gaps = computed(() => savings.value?.input.gaps.slice(0, 5) ?? []);
</script>

<template>
    <RowGroup data-setting="agent-command-output" :label="t(`sandbox.agentCommandOutput.commandOutput`)">
        <!-- One switch is the whole decision; what it saved hangs under its name, and the parts behind it fold away. -->
        <Row
            indent
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
            <template v-if="settings !== undefined && cleaningOn" #below>
                <div class="flex min-w-0 flex-col gap-3">
                    <div v-if="summary !== undefined">
                        <Verdict :value="summary.value" :unit="summary.unit" :tone="summary.tone" />
                        <p class="mt-1 text-2xs text-subtle">
                            {{ summary.detail }}
                            <RouterLink v-if="summary.measured" to="/sandbox/usage" class="ml-1 whitespace-nowrap text-link hover:underline">{{
                                t(`sandbox.agentCommandOutput.breakdown`)
                            }}</RouterLink>
                        </p>
                    </div>

                    <details class="group/advanced min-w-0">
                        <summary
                            class="flex w-fit max-w-full cursor-pointer list-none flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-sm text-xs text-muted hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden"
                        >
                            <span class="flex items-center gap-1.5">
                                <Icon
                                    name="chevron-right"
                                    aria-hidden="true"
                                    class="text-2xs text-subtle transition-transform group-open/advanced:rotate-90"
                                />
                                {{ t(`sandbox.agentCommandOutput.advanced`) }}
                            </span>
                            <span class="text-2xs text-subtle">{{ advancedFacts.join(` · `) }}</span>
                        </summary>

                        <div class="mt-3 flex min-w-0 flex-col gap-5">
                            <!-- Capped like the measurement table under it, so a switch stays within reach of its name on a wide pane. -->
                            <div class="@container/cleaners flex min-w-0 max-w-xl flex-col gap-2">
                                <p class="flex flex-wrap items-baseline gap-x-2 text-2xs text-subtle">
                                    <span class="font-medium uppercase tracking-wide">{{ t(`sandbox.agentCommandOutput.cleaners`) }}</span>
                                    <!-- Per-switch savings turn twelve identical toggles into a list you can prune by impact. -->
                                    <span>{{ t(`sandbox.agentCommandOutput.tokensSavedAllTime`) }}</span>
                                </p>
                                <div class="grid grid-cols-1 gap-x-6 gap-y-1.5 @md/cleaners:grid-cols-2">
                                    <label
                                        v-for="cleaner in cleanerOptions()"
                                        :key="cleaner.id"
                                        class="flex min-w-0 items-center justify-between gap-2"
                                    >
                                        <span class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                                            <span class="min-w-0 break-words text-xs text-content">{{ cleaner.label }}</span>
                                            <!-- Absent means not yet measured, a different claim from zero. -->
                                            <span
                                                v-if="savedTokens.get(cleaner.id) !== undefined"
                                                class="shrink-0 text-2xs tabular-nums text-success"
                                            >
                                                ~{{ formatTokens(savedTokens.get(cleaner.id) ?? 0) }}
                                            </span>
                                        </span>
                                        <ToggleSwitch
                                            class="shrink-0"
                                            :model-value="enabledCleaners.has(cleaner.id)"
                                            @update:model-value="(value: boolean) => toggleCleaner(cleaner.id, value)"
                                        />
                                    </label>
                                </div>
                                <p v-if="gaps.length > 0" class="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-2xs">
                                    <span class="text-subtle">{{ t(`sandbox.agentCommandOutput.notCovered`) }}</span>
                                    <span
                                        v-for="gap in gaps"
                                        :key="gap.command"
                                        v-tooltip.top="t(`sandbox.agentCommandOutput.runs`, { count: gap.commands }, gap.commands)"
                                        tabindex="0"
                                        class="inline-flex min-w-0 max-w-full cursor-help items-baseline gap-1"
                                    >
                                        <code class="min-w-0 truncate font-mono text-muted">{{ gap.command }}</code>
                                        <span class="shrink-0 tabular-nums text-subtle">~{{ formatTokens(gap.tokens) }}</span>
                                    </span>
                                </p>
                            </div>

                            <!-- Leaves a share of commands raw so the saving is measured against a real baseline, not just estimated. -->
                            <MeasurementPanel
                                :percent="holdoutPercent"
                                :table="cleanerTable"
                                :note="t(`sandbox.agentCommandOutput.ofCommandsRunUncleaned`)"
                                :on-label="t(`sandbox.agentCommandOutput.cleaned`)"
                                :off-label="t(`sandbox.agentCommandOutput.raw`)"
                                @commit="(outputHoldout: number) => patch({ outputHoldout })"
                            />
                        </div>
                    </details>
                </div>
            </template>
        </Row>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
