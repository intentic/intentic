<script setup lang="ts">
import { COMMAND_RULE_CATALOG, type CommandRuleTier } from "@intentic/sandbox-contract/policy/safety-policy";
import type { CommandLocus } from "@intentic/sandbox-contract/schemas/command-admission";
import RuleCommand from "../../../components/RuleCommand.vue";
import { commandClassWords, qualifierWords } from "./ruleWords";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

// Read-only table of COMMAND_RULE_CATALOG (safety-policy.ts): one row per command class, one column per machine
// (sandbox, device), the same catalog both gates enforce. No controls, so it does not take a place among the settings:
// it is the body of the Safety judge group's (i) dialog, which names it. Change a pattern in the catalog or write a
// rule in the policy, not here.

const t = useT();

const MACHINES = computed(
    () =>
        [
            { locus: `sandbox`, label: t(`shared.thisSandbox`), track: `bg-content/[0.02]` },
            { locus: `device`, label: t(`sandbox.agentSafetyRules.myDevices`), track: `bg-content/[0.045]` },
        ] as const satisfies readonly { locus: CommandLocus; label: string; track: string }[],
);

// ONE RECORD PER TIER, two views of it: the word and the tone it takes wherever it's shown, so a tier cannot end up
// spelled two ways. "Judged" and "Always asks" name the consequence, not the mechanism; context already says what
// judging means, and amber is the half a reader cannot waive.
const TIERS = computed((): Readonly<Record<CommandRuleTier, { label: string; tone: string }>> => ({
    hard: { label: t(`sandbox.agentSafetyRules.alwaysAsks`), tone: `font-medium text-warning` },
    judged: { label: t(`sandbox.agentSafetyRules.judged`), tone: `text-subtle` },
}));

// ONE MACHINE'S COLUMN, WRITTEN ONCE. Its head, its track and every verdict in it are the same column seen three times,
// so a column that changes width stays a column. The inset keeps a long head (a translated "My devices") off the
// neighbouring track: it wraps inside its own.
const COLUMN = `w-28 px-2`;

// Labels are lowercase in the contract so gate copy can say "would wipe a disk"; row titles here stand alone.
const rowTitle = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);
</script>

<template>
    <!-- `@container`, not a viewport breakpoint: this table's width is the dialog's, not the phone's. -->
    <!-- A table, not a <RowGroup>: a <Row> sizes a title-only headline by its content, and a title that is a wrapping run
         of chips is wider than any dialog, so the verdicts would always fall onto a line of their own under it. Here the
         title takes what the machine columns leave and wraps inside it. -->
    <div class="relative @container">
        <!-- TWO tracks, touching: each machine gets its own wash so the columns read apart without a gutter between them. -->
        <div aria-hidden="true" class="pointer-events-none absolute inset-y-0 right-0 hidden @2xl:flex">
            <span
                v-for="(machine, index) in MACHINES"
                :key="machine.locus"
                :class="[COLUMN, machine.track, index === 0 ? `rounded-l-md` : ``, index === MACHINES.length - 1 ? `rounded-r-md` : ``]"
            />
        </div>

        <div class="relative hidden @2xl:flex">
            <span class="min-w-0 flex-1" />
            <span
                v-for="machine in MACHINES"
                :key="machine.locus"
                class="flex shrink-0 items-center justify-center py-2.5 text-center text-3xs font-medium text-subtle"
                :class="COLUMN"
            >
                {{ machine.label }}
            </span>
        </div>

        <div v-for="rule in COMMAND_RULE_CATALOG" :key="rule.commandClass" class="relative flex items-center py-2.5">
            <div class="min-w-0 flex-1 text-sm font-medium leading-tight text-content @2xl:pr-4">
                <span class="inline-flex max-w-full flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
                    <span>{{ rowTitle(commandClassWords(rule.commandClass)) }}:</span>
                    <span
                        v-for="pattern in rule.patterns"
                        :key="pattern.code"
                        v-tooltip.top="pattern.qualifier === undefined ? undefined : qualifierWords(pattern.qualifier)"
                        class="inline-flex max-w-full items-center rounded bg-overlay px-1.5 py-0.5 text-2xs font-normal"
                        :class="pattern.qualifier !== undefined ? `cursor-help` : undefined"
                    >
                        <RuleCommand :command="pattern.code" />
                    </span>
                </span>
                <!-- Narrow: no columns to tell apart, so the same TIERS lookup is spoken as a sentence. -->
                <p class="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs font-normal @2xl:hidden">
                    <span v-for="machine in MACHINES" :key="machine.locus">
                        <span class="text-subtle">{{ machine.label }} — </span>
                        <span :class="TIERS[rule.tiers[machine.locus]].tone">{{ TIERS[rule.tiers[machine.locus]].label }}</span>
                    </span>
                </p>
            </div>

            <!-- `items-center` on the row keeps each verdict centred on its title however many lines that wraps to. -->
            <span
                v-for="machine in MACHINES"
                :key="machine.locus"
                class="hidden shrink-0 justify-center text-center text-2xs @2xl:flex"
                :class="[COLUMN, TIERS[rule.tiers[machine.locus]].tone]"
            >
                {{ TIERS[rule.tiers[machine.locus]].label }}
            </span>
        </div>
    </div>
</template>
