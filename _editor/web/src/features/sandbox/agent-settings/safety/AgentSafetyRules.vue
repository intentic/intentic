<script setup lang="ts">
import { COMMAND_RULE_CATALOG, type CommandLocus, type CommandRuleTier } from "@intentic/sandbox-contract";
import { Row, RowGroup, RowNote } from "@intentic/ui";
import RuleCommand from "./RuleCommand.vue";

// Read-only table of COMMAND_RULE_CATALOG (safety-policy.ts): one row per command class, one column per machine
// (sandbox, device), the same catalog both gates enforce. No controls: change a pattern in the catalog or write a rule
// in the policy below, not here.

const MACHINES = [
    { locus: `sandbox`, label: `This sandbox` },
    { locus: `device`, label: `My devices` },
] as const satisfies readonly { locus: CommandLocus; label: string }[];

// "Judged" and "Always asks" name the consequence, not the mechanism; context already says what judging means.
const VERDICTS: Readonly<Record<CommandRuleTier, string>> = {
    hard: `Always asks`,
    judged: `Judged`,
};

// Amber marks the tier the reader cannot change; the only tone this column needs to differentiate.
const VERDICT_TONE: Readonly<Record<CommandRuleTier, string>> = {
    hard: `font-medium text-warning`,
    judged: `text-subtle`,
};

// ONE MACHINE'S COLUMN, WRITTEN ONCE. The head, the verdict on every row and the empty spacer that holds the patterns
// out of the columns are the same column seen three times, so a column that changes width stays a column.
const COLUMN = `w-22 text-right`;

// The wash behind BOTH columns, measured from the card's right edge: two `w-22` columns, the `gap-2` <Row> puts
// between them, and the row's own `px-4` — 12.5rem. It is what tells the two machines apart from the rules now that
// no line does, and what the patterns stop at.
const COLUMNS_WASH = `w-50 bg-content/4`;
</script>

<template>
    <!-- `@container`, not a viewport breakpoint: this panel's width is its containing pane, not the phone. -->
    <RowGroup class="@container" label="What gets stopped">
        <RowNote>
            A command is only ever looked at if it matches one of these. Everything else runs without a model reading it and without anything being
            recorded.
        </RowNote>

        <!--
            The heads, the rules and the wash behind the machine columns are ONE child of the group, so the group's
            hairlines fall around the table instead of boxing the two heads into a band of their own. Inside it only
            the rules are divided: a head sitting at the top of its own column does not need a rule under it to say
            what it names.
        -->
        <div class="relative">
            <!-- Decorative, and positioned, so it is drawn under rows that are positioned after it (`relative`, below). -->
            <div aria-hidden="true" class="pointer-events-none absolute inset-y-0 right-0 hidden @lg:block" :class="COLUMNS_WASH" />

            <!--
                Row with only #meta, not a padded div, so the heads inherit Row's own tier padding and gap (enforced by
                _tools/checks/row-tiers.mjs) and land on the columns they name.
                font-medium, not font-semibold: that pairing with uppercase tracking-wide is this app's section-label style.
            -->
            <div class="relative hidden @lg:block">
                <Row>
                    <template #meta>
                        <span v-for="machine in MACHINES" :key="machine.locus" class="text-3xs font-medium uppercase tracking-wide" :class="COLUMN">{{
                            machine.label
                        }}</span>
                    </template>
                </Row>
            </div>

            <div class="relative divide-y divide-line-subtle">
                <Row v-for="rule in COMMAND_RULE_CATALOG" :key="rule.commandClass" :title="rule.label">
                    <!-- #meta is already tabular and trailing, so reusing it here lines up the verdict column for free. -->
                    <template #meta>
                        <span
                            v-for="machine in MACHINES"
                            :key="machine.locus"
                            class="hidden @lg:block"
                            :class="[COLUMN, VERDICT_TONE[rule.tiers[machine.locus]]]"
                            >{{ VERDICTS[rule.tiers[machine.locus]] }}</span
                        >
                    </template>

                    <template #below>
                        <div class="flex flex-col gap-2">
                            <!-- Same VERDICTS/VERDICT_TONE lookup as the wide column, so the narrow and wide spellings cannot drift apart. -->
                            <p class="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs @lg:hidden">
                                <span v-for="machine in MACHINES" :key="machine.locus">
                                    <span class="text-subtle">{{ machine.label }} — </span>
                                    <span :class="VERDICT_TONE[rule.tiers[machine.locus]]">{{ VERDICTS[rule.tiers[machine.locus]] }}</span>
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
                                <span aria-hidden="true" class="hidden shrink-0 gap-2 @lg:flex">
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
