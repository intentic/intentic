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
</script>

<template>
    <!-- `@container`, not a viewport breakpoint: this panel's width is its containing pane, not the phone. -->
    <RowGroup class="@container" label="What gets stopped" :count="`${COMMAND_RULE_CATALOG.length} kinds`">
        <RowNote>
            A command is only ever looked at if it matches one of these. Everything else runs without a model reading it and without anything being
            recorded.
        </RowNote>

        <!--
            Row with only #meta, not a padded div, so the columns inherit Row's own tier padding and gap (enforced by _tools/checks/row-tiers.mjs).
            font-medium, not font-semibold: that pairing with uppercase tracking-wide is this app's section-label style.
        -->
        <div class="hidden @lg:block">
            <Row>
                <template #meta>
                    <span
                        v-for="machine in MACHINES"
                        :key="machine.locus"
                        class="w-22 text-right text-3xs font-medium uppercase tracking-wide"
                        >{{ machine.label }}</span
                    >
                </template>
            </Row>
        </div>

        <Row v-for="rule in COMMAND_RULE_CATALOG" :key="rule.commandClass" :title="rule.label">
            <!-- #meta is already tabular and trailing, so reusing it here lines up the verdict column for free. -->
            <template #meta>
                <span
                    v-for="machine in MACHINES"
                    :key="machine.locus"
                    class="hidden w-22 text-right @lg:block"
                    :class="VERDICT_TONE[rule.tiers[machine.locus]]"
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

                    <!-- Chip and qualifier are one flex item so a wrap cannot strand the qualifier on its own line. -->
                    <ul class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                        <li v-for="pattern in rule.patterns" :key="pattern.code" class="flex min-w-0 items-center gap-1.5">
                            <span class="inline-flex max-w-full items-center rounded border border-line-subtle bg-overlay px-1.5 py-0.5 text-2xs">
                                <RuleCommand :command="pattern.code" />
                            </span>
                            <span v-if="pattern.qualifier !== undefined" class="text-2xs text-subtle">{{ pattern.qualifier }}</span>
                        </li>
                    </ul>

                    <!-- Meaning depends on the machine: "a whole root" differs by machine, so both answers show, not just one. -->
                    <div v-if="rule.notes !== undefined" class="flex flex-col gap-0.5 border-l border-line-subtle pl-2.5">
                        <p class="text-2xs text-muted">What counts as a root:</p>
                        <p v-for="machine in MACHINES" :key="machine.locus" class="text-2xs text-subtle">
                            <span class="text-muted">{{ machine.label }}</span> — {{ rule.notes[machine.locus] }}
                        </p>
                    </div>
                </div>
            </template>
        </Row>

        <!-- A command that only mentions a pattern (echo, grep, a heredoc) does not match it here. -->
        <RowNote>
            A command that only mentions one of these — printed by an <code class="font-mono text-content">echo</code>, searched for by a
            <code class="font-mono text-content">grep</code>, written into a heredoc — is not doing it, and never reaches the rules above.
        </RowNote>
    </RowGroup>
</template>
