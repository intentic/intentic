<script setup lang="ts">
import { COMMAND_RULE_CATALOG, type CommandLocus, type CommandRuleTier } from "@intentic/sandbox-contract";
import { Row, RowGroup, StatusBadge, type StatusVariant } from "@intentic/ui";
import RuleCommand from "./RuleCommand.vue";

// Read-only table of COMMAND_RULE_CATALOG (safety-policy.ts): one row per command class, one column per machine
// (sandbox, device), the same catalog both gates enforce. No controls: change a pattern in the catalog or write a rule
// in the policy below, not here.

const MACHINES = [
    { locus: `sandbox`, label: `This sandbox` },
    { locus: `device`, label: `My devices` },
] as const satisfies readonly { locus: CommandLocus; label: string }[];

// ONE RECORD PER TIER, three views of it: the word, the pill it wears in a machine's column, and the tone it takes in
// the narrow line, so a tier cannot end up spelled two ways. "Judged" and "Always asks" name the consequence, not the
// mechanism; context already says what judging means, and amber is the half a reader cannot waive.
const TIERS: Readonly<Record<CommandRuleTier, { label: string; badge: StatusVariant; tone: string }>> = {
    hard: { label: `Always asks`, badge: `warning`, tone: `font-medium text-warning` },
    judged: { label: `Judged`, badge: `neutral`, tone: `text-subtle` },
};

// ONE MACHINE'S COLUMN, WRITTEN ONCE. Its head, its track, every verdict in it and the empty spacer that holds the
// patterns out of it are the same column seen four times, so a column that changes width stays a column.
const COLUMN = `w-24`;

// Labels are lowercase in the contract so gate copy can say "would wipe a disk"; row titles here stand alone.
const rowTitle = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);
</script>

<template>
    <!-- `@container`, not a viewport breakpoint: this panel's width is its containing pane, not the phone. -->
    <RowGroup class="@container" label="What gets stopped">
        <!--
            The heads, the rules and the two tracks behind the machine columns are ONE child of the group, so the
            group's hairlines fall around the table instead of boxing the heads into a band of their own.
        -->
        <div class="relative">
            <!--
                TWO tracks with a gap, not one wash across both: a single field made the right-hand side one grey
                area with words floating in it, and which answer belonged to which machine had to be worked out from
                alignment alone. Decorative, and positioned, so it is drawn under the rows, which are positioned after
                it (`relative`, below). `right-4` is the row's own padding, so the tracks sit exactly under the cells.
            -->
            <div aria-hidden="true" class="pointer-events-none absolute inset-y-0 right-4 hidden gap-2 @2xl:flex">
                <span v-for="machine in MACHINES" :key="machine.locus" class="rounded-md bg-content/[0.025]" :class="COLUMN" />
            </div>

            <!--
                Row with only #meta, not a padded div, so the heads inherit Row's own tier padding and gap (enforced by
                _tools/checks/row-tiers.mjs) and land centred on the track they name.
                font-medium, not font-semibold: that pairing with uppercase tracking-wide is this app's section-label style.
            -->
            <div class="relative hidden @2xl:block">
                <Row>
                    <template #meta>
                        <div class="flex self-stretch items-center gap-2">
                            <span
                                v-for="machine in MACHINES"
                                :key="machine.locus"
                                class="flex h-full items-center justify-center whitespace-nowrap px-3 text-center text-3xs font-medium uppercase tracking-wide"
                                :class="COLUMN"
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

                    <!--
                        self-stretch + h-full: badges stay centred on the row when the title wraps to several lines.
                        #meta is already trailing, so reusing it lines the cells up with the heads for free.
                    -->
                    <template #meta>
                        <div class="hidden self-stretch items-center gap-2 @2xl:flex">
                            <span
                                v-for="machine in MACHINES"
                                :key="machine.locus"
                                class="flex h-full items-center justify-center"
                                :class="COLUMN"
                            >
                                <StatusBadge
                                    size="xs"
                                    :variant="TIERS[rule.tiers[machine.locus]].badge"
                                    :label="TIERS[rule.tiers[machine.locus]].label"
                                />
                            </span>
                        </div>
                    </template>
                </Row>
            </div>
        </div>
    </RowGroup>
</template>
