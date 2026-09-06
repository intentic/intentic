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

/* WHAT THE HOLDOUT HAS BOUGHT, in the shape <MeasurementPanel> draws for the other two experiments. This row
 * used to spell its own version of that block — the same "% of X left alone, as a control" label and the same
 * 26px field, hand-drawn, at `text-xs text-content` where the shared one was `text-xs font-medium text-content`
 * — so three settings that do one thing read as three things.
 *
 * ASSEMBLED RATHER THAN TAKEN FROM `verdictsOf` because this experiment is not a turn-level one: it compares
 * whole COMMANDS, cleaned against raw, so the daemon reports it as a share rather than as two arms of means.
 * The verdict slot takes the answer either way, which is the point of there being a slot.
 *
 * NO READING UNTIL THERE IS ONE. `measuredSavedPct` is absent until both arms have commands in them, and the
 * panel shows the control alone until then: "0%" would be a measurement, and there has not been one. */
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
                // Success only because this is the MEASURED figure: the estimate above it never earns the tone.
                tone: holdout.measuredSavedPct > 0 ? `success` : `muted`,
                detail: `cleaned commands against the raw ones the holdout kept`,
            },
            on: holdout.cleaned,
            off: holdout.heldOut,
        },
    ];
});

/* THE LEDGER'S OWN HEADLINE, which is a different claim from the one above it: this is every command the
 * cleaners have touched, estimated against what each one would have emitted raw, where the holdout figure is
 * the slice that was actually left raw to check it against.
 *
 * It moved out of the row's `#description` to get here. A description is what a setting IS — static text a
 * reader learns once — and this row was putting a live figure, its provenance and its freshness in that slot,
 * as a run-on sentence with a `<br>` in it. <Row> keeps facts and explanation in different places on purpose. */
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

/* What each mechanism has been worth, all-time: the readout that belongs NEXT TO ITS SWITCH. Unwindowed on
 * purpose: this page is where a switch is flipped, not where a period is compared, and the Usage tab's Savings
 * section owns the windowed chart. */
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
                         cleaned-vs-raw baseline instead of an estimate. The SAME block the iq search teaching
                         carries, said in the same words: both settings that measure themselves do it this way,
                         and a reader who has understood one has understood the other. -->
                    <!-- `mt-3` on top of the stack's own `gap-2`: the 20px this block had before. It is not the
                         12px the other panel sits at under its row header, and should not be — what is above it
                         there is the setting's own description, and what is above it here is a grid of sixteen
                         switches, which needs more air to read as a block that has ended. -->
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

        <!-- Realized savings. The hero is one number; everything that qualifies it — freshness, what it is a
             share of — sits under it rather than trailing it as a run-on, because those are the facts that tell
             a live figure from a frozen one, and this row once sat on a ledger nothing was writing any more.
             The breakdown BY mechanism lives on the Usage tab, where a window exists to compare it over.

             THE FIGURE IS A <Verdict> IN `#below`, NOT PROSE IN `#description`. Absence is a verdict too
             ("Nothing yet", muted, in the same slot): the row used to fall back to a grey sentence in the
             description, so the one state a reader most needs to recognise was the one drawn least like the
             others. Before that it wasn't rendered at all, and a page of switches promising savings showed
             nothing whatever about them. -->
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
                    <!-- WHERE THE NEXT CLEANER WOULD PAY. Grouped by command and ranked by total, so the list
                         answers "what is worth a handler" rather than "which single run was biggest", and the
                         count is shown because a command that costs this much across twenty runs is the one to
                         write for. -->
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
