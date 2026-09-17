<script setup lang="ts">
import { COMMAND_RULE_CATALOG, type CommandLocus, type CommandRuleTier } from "@intentic/sandbox-contract";
import { Row, RowGroup } from "@intentic/ui";
import RuleCommand from "./RuleCommand.vue";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

// Read-only table of COMMAND_RULE_CATALOG (safety-policy.ts): one row per command class, one column per machine
// (sandbox, device), the same catalog both gates enforce. No controls: change a pattern in the catalog or write a rule
// in the policy below, not here.

const t = useT();

const MACHINES = computed(
    () =>
        [
            { locus: `sandbox`, label: t(`sandbox.agentSafetyRules.sandbox`), track: `bg-content/[0.02]` },
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

// ONE MACHINE'S COLUMN, WRITTEN ONCE. Its head, its track, every verdict in it and the empty spacer that holds the
// patterns out of it are the same column seen four times, so a column that changes width stays a column.
const COLUMN = `w-28`;
const COLUMN_PAD = `px-5`;

// Labels are lowercase in the contract so gate copy can say "would wipe a disk"; row titles here stand alone.
const rowTitle = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);
</script>

<template>
    <!-- `@container`, not a viewport breakpoint: this panel's width is its containing pane, not the phone. -->
    <RowGroup class="@container" :label="t(`sandbox.agentSafetyRules.whatGetsStopped`)">
        <!-- The heads, the rules and the two tracks behind the machine columns are ONE child of the group. -->
        <div class="relative">
            <!-- TWO tracks, touching: each machine gets its own wash so the columns read apart without a gutter between them. -->
            <div aria-hidden="true" class="pointer-events-none absolute inset-y-0 right-4 hidden @2xl:flex">
                <span
                    v-for="(machine, index) in MACHINES"
                    :key="machine.locus"
                    :class="[COLUMN, machine.track, index === 0 ? `rounded-l-md` : ``, index === MACHINES.length - 1 ? `rounded-r-md` : ``]"
                />
            </div>

            <!-- Keep #meta rows unpadded so headings align with Row's tier. -->
            <div class="relative hidden @2xl:block">
                <Row>
                    <template #meta>
                        <div class="flex self-stretch items-center">
                            <span
                                v-for="machine in MACHINES"
                                :key="machine.locus"
                                class="flex h-full items-center justify-center whitespace-nowrap text-center text-3xs font-medium uppercase tracking-wide"
                                :class="[COLUMN, COLUMN_PAD]"
                            >
                                {{ machine.label }}
                            </span>
                        </div>
                    </template>
                </Row>
            </div>

            <div class="relative">
                <Row v-for="rule in COMMAND_RULE_CATALOG" :key="rule.commandClass">
                    <template #title>
                        <div>
                            <span class="inline-flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
                                <span>{{ rowTitle(rule.label) }}:</span>
                                <span
                                    v-for="pattern in rule.patterns"
                                    :key="pattern.code"
                                    v-tooltip.top="pattern.qualifier"
                                    class="inline-flex max-w-full items-center rounded bg-overlay px-1.5 py-0.5 text-2xs"
                                    :class="pattern.qualifier !== undefined ? `cursor-help` : undefined"
                                >
                                    <RuleCommand :command="pattern.code" />
                                </span>
                            </span>
                            <!-- Narrow: no columns to tell apart, so the same TIERS lookup is spoken as a sentence. -->
                            <p class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs @2xl:hidden">
                                <span v-for="machine in MACHINES" :key="machine.locus">
                                    <span class="text-subtle">{{ machine.label }} — </span>
                                    <span :class="TIERS[rule.tiers[machine.locus]].tone">{{ TIERS[rule.tiers[machine.locus]].label }}</span>
                                </span>
                            </p>
                        </div>
                    </template>

                    <!-- self-stretch + h-full: badges stay centred on the row when the title wraps to several lines. -->
                    <template #meta>
                        <div class="hidden self-stretch items-center @2xl:flex">
                            <span
                                v-for="machine in MACHINES"
                                :key="machine.locus"
                                class="flex h-full items-center justify-center"
                                :class="[COLUMN, COLUMN_PAD]"
                            >
                                <span class="text-2xs" :class="TIERS[rule.tiers[machine.locus]].tone">
                                    {{ TIERS[rule.tiers[machine.locus]].label }}
                                </span>
                            </span>
                        </div>
                    </template>
                </Row>
            </div>
        </div>
    </RowGroup>
</template>
