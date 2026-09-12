<script setup lang="ts">
import { COMMAND_RULE_CATALOG, type CommandLocus, type CommandRuleTier } from "@intentic/sandbox-contract";
import { type IconName, Row, RowGroup, RowNote, StatusBadge, type StatusVariant } from "@intentic/ui";
import RuleCommand from "./RuleCommand.vue";

// Read-only table of COMMAND_RULE_CATALOG (safety-policy.ts): one row per command class, one column per machine
// (sandbox, device), the same catalog both gates enforce. No controls: change a pattern in the catalog or write a rule
// in the policy below, not here.

// Each machine carries its own mark, because the two columns are the thing a reader has to keep apart while their eye
// travels down the table, and two words in small caps at the top were not enough to hold that apart on their own.
const MACHINES = [
    { locus: `sandbox`, label: `This sandbox`, icon: `box` },
    { locus: `device`, label: `My devices`, icon: `desktop` },
] as const satisfies readonly { locus: CommandLocus; label: string; icon: IconName }[];

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
</script>

<template>
    <!-- `@container`, not a viewport breakpoint: this panel's width is its containing pane, not the phone. -->
    <RowGroup class="@container" label="What gets stopped">
        <RowNote>
            A command is only ever looked at if it matches one of these. Everything else runs without a model reading it and without anything being
            recorded.
        </RowNote>

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
                        <span
                            v-for="machine in MACHINES"
                            :key="machine.locus"
                            class="flex items-center justify-center gap-1 whitespace-nowrap text-3xs font-medium uppercase tracking-wide"
                            :class="COLUMN"
                        >
                            <Icon :name="machine.icon" class="text-2xs" aria-hidden="true" />{{ machine.label }}
                        </span>
                    </template>
                </Row>
            </div>

            <div class="relative divide-y divide-line-subtle">
                <Row v-for="rule in COMMAND_RULE_CATALOG" :key="rule.commandClass" :title="rule.label">
                    <!--
                        A pill per cell, centred on its track: an answer with an edge round it belongs to one row and one
                        machine, where a bare word in a shared field belonged to neither. #meta is already trailing, so
                        reusing it lines the cells up with the heads for free.
                    -->
                    <template #meta>
                        <span v-for="machine in MACHINES" :key="machine.locus" class="hidden justify-center @2xl:flex" :class="COLUMN">
                            <StatusBadge
                                size="xs"
                                :variant="TIERS[rule.tiers[machine.locus]].badge"
                                :label="TIERS[rule.tiers[machine.locus]].label"
                            />
                        </span>
                    </template>

                    <template #below>
                        <div class="flex flex-col gap-2">
                            <!--
                                Narrow: no columns to tell apart, so the same TIERS lookup is spoken as a sentence
                                rather than drawn as a cell, and the two spellings cannot drift apart.
                            -->
                            <p class="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs @2xl:hidden">
                                <span v-for="machine in MACHINES" :key="machine.locus">
                                    <span class="text-subtle">{{ machine.label }} — </span>
                                    <span :class="TIERS[rule.tiers[machine.locus]].tone">{{ TIERS[rule.tiers[machine.locus]].label }}</span>
                                </span>
                            </p>

                            <!--
                                Everything under the row ends where the machine columns begin. The gutter is an empty
                                second copy of those columns — same `COLUMN`, same `gap-2`, same outer `gap-4` <Row>
                                itself uses — rather than a typed `pr-*`, which is how a chip ended up wrapping
                                underneath a verdict and reading as one.
                            -->
                            <div class="flex gap-4">
                                <div class="flex min-w-0 flex-1 flex-col gap-2">
                                    <!-- Chip and qualifier are one flex item so a wrap cannot strand the qualifier on its own line. -->
                                    <ul class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                                        <li v-for="pattern in rule.patterns" :key="pattern.code" class="flex min-w-0 items-center gap-1.5">
                                            <!-- Fill, no border: 40-odd outlined chips made the panel read as a grid of boxes. -->
                                            <span class="inline-flex max-w-full items-center rounded bg-overlay px-1.5 py-0.5 text-2xs">
                                                <RuleCommand :command="pattern.code" />
                                            </span>
                                            <span v-if="pattern.qualifier !== undefined" class="text-2xs text-subtle">{{ pattern.qualifier }}</span>
                                        </li>
                                    </ul>

                                    <!-- Meaning depends on the machine: "a whole root" differs by machine, so both answers show, not just one. -->
                                    <div v-if="rule.notes !== undefined" class="flex flex-col gap-0.5 rounded-md bg-content/4 px-2.5 py-1.5">
                                        <p class="text-2xs text-muted">What counts as a root:</p>
                                        <p v-for="machine in MACHINES" :key="machine.locus" class="text-2xs text-subtle">
                                            <span class="text-muted">{{ machine.label }}</span> — {{ rule.notes[machine.locus] }}
                                        </p>
                                    </div>
                                </div>
                                <span aria-hidden="true" class="hidden shrink-0 gap-2 @2xl:flex">
                                    <span v-for="machine in MACHINES" :key="machine.locus" :class="COLUMN" />
                                </span>
                            </div>
                        </div>
                    </template>
                </Row>
            </div>
        </div>

        <!-- A command that only mentions a pattern (echo, grep, a heredoc) does not match it here. -->
        <RowNote>
            A command that only mentions one of these — printed by an <code class="font-mono text-content">echo</code>, searched for by a
            <code class="font-mono text-content">grep</code>, written into a heredoc — is not doing it, and never reaches the rules above.
        </RowNote>
    </RowGroup>
</template>
