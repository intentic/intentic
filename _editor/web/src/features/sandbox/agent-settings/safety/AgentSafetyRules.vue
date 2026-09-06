<script setup lang="ts">
import { COMMAND_RULE_CATALOG, type CommandLocus, type CommandRuleTier } from "@intentic/sandbox-contract";
import { Row, RowGroup, RowNote } from "@intentic/ui";
import RuleCommand from "./RuleCommand.vue";

/* WHAT THE GATE STOPS, LISTED, and the reason this group exists at all.
 *
 * THE COMPLAINT IT ANSWERS was a card asking to approve `docker volume rm` against a smoke-test container. Two
 * things were wrong with that card and only one of them was a bug. The bug was the rule (the catalog now reads
 * container state as its own class and the sandbox's hard rule no longer holds it). The other thing was that
 * there was nowhere to go and look: the page offered a switch, a prose policy and a log of decisions already
 * made, and no answer at all to "what is going to interrupt me, and which of it can I change?".
 *
 * IT IS A TABLE, because the question is a comparison. Seven classes down the side, two machines across the
 * top, and the cell is where that class stands on that machine. Everything below follows from taking that
 * shape seriously.
 *
 * WHAT IT REPLACED, and why the shape was the disease rather than the styling. This was two disclosures split
 * by TIER — "Never judged" over "Gets a second look" — with each half listed per machine inside. The split is
 * a good instinct: whether the owner gets a say is the only cut that changes what they do next. But three of
 * the seven classes are hard on a laptop and judged in this container, so each of those three was PRINTED
 * TWICE, once under each heading, with identical patterns under it. The page then spent a paragraph
 * ("This is the list for the sandbox. On your own computers, these always ask instead: …") telling the reader
 * it had not contradicted itself. That is the wall: fourteen rows of rules to say seven things, plus the prose
 * needed to reconcile them, plus a machine sub-heading inside each half, all set at one size in three greys.
 *
 * SO THE TIER STOPPED BEING AN AXIS AND BECAME A CELL. Each class appears exactly once; its two verdicts sit
 * side by side where the difference between the machines is READ rather than narrated; and the ordering does
 * the job the tier split was reaching for, since the catalog arrives sorted most-locked-first (safety-policy.ts
 * argues the sort). Nobody has to be told the machines differ — the columns are the telling.
 *
 * THE PATTERNS ARE CODE AND ARE DRAWN AS CODE. They used to be prose strings joined with ` · ` in a grey
 * LIGHTER than the label above them, so the one genuinely scannable thing on the panel — the actual command
 * you are about to be stopped for — was the least visible. They are chips now, monospaced and syntax
 * highlighted through the same Shiki path as every other command in this app. That only became possible when
 * the contract stopped mixing a fragment and its qualifier into one string (command-classes.ts CommandPattern
 * argues that split); the qualifier stays prose beside the chip, because highlighting a sentence is what makes
 * highlighting look broken.
 *
 * FOUR SIZES, NOT ONE. Label, code, qualifier and note were all `text-2xs` separated only by grey, which is
 * why a reader had nothing to scan by and had to read every line to find the one they wanted.
 *
 * READ-ONLY, DELIBERATELY. Every line here comes from the contract (safety-policy.ts COMMAND_RULE_CATALOG),
 * which is the same constant both gates consult, so this cannot drift from enforcement the way a hand-written
 * list of the same facts would. It is also why there are no controls: the tuning surface for all of it is the
 * policy document below, and a regex box on a settings page is a way to switch off a disk-wipe guard with a
 * typo. If a pattern here is wrong, the fix is a line in the policy or a change to the catalog, not a field. */

const MACHINES = [
    { locus: `sandbox`, label: `This sandbox` },
    { locus: `device`, label: `My devices` },
] as const satisfies readonly { locus: CommandLocus; label: string }[];

/* THE CELL'S WORDS. "Judged" is the whole sentence because the column head already said which machine and the
 * note above already said what judging is; "Always asks" is two words rather than "never judged" because the
 * reader wants the CONSEQUENCE, and the consequence of no judge is a card every time. */
const VERDICTS: Readonly<Record<CommandRuleTier, string>> = {
    hard: `Always asks`,
    judged: `Judged`,
};

// Amber is the app's warning colour and it is spent here on the one thing a reader can do nothing about, so a
// column skimmed for "where do I have no say" answers before any of it is read.
const VERDICT_TONE: Readonly<Record<CommandRuleTier, string>> = {
    hard: `font-medium text-warning`,
    judged: `text-subtle`,
};
</script>

<template>
    <!-- `@container` and not a viewport breakpoint: this panel is as wide as whatever pane it is in, and the
         narrow spelling below is about the two verdict columns crowding the label rather than about a phone. -->
    <RowGroup class="@container" label="What gets stopped" :count="`${COMMAND_RULE_CATALOG.length} kinds`">
        <RowNote>
            A command is only ever looked at if it matches one of these. Everything else runs without a model reading it and without anything being
            recorded.
        </RowNote>

        <!-- THE MACHINES ARE NAMED ONCE, AT THE TOP, instead of on all fourteen cells under them. Dropped below
             `@lg`, where the columns are dropped too.

             IT IS A <Row> WITH NOTHING BUT `#meta`, and that is what makes the table a table: the captions are
             then drawn by the same cluster, at the same tier padding and the same gap, as the cells they head.
             Written as a padded <div> instead — which is how this shipped first — the columns aligned only for
             as long as two hand-typed numbers happened to agree with <Row>'s, and the checkout gate
             (_tools/checks/row-tiers.mjs) refuses that on exactly those grounds.

             `font-medium` AND NOT `font-semibold`, which is not a weight preference: `.font-semibold.uppercase
             .tracking-wide` is how this app spells a SECTION LABEL, and the sanctum skin opens every one of
             them with a gold lozenge. Spelled that way these came out as two more lozenges under the one on
             "What gets stopped" — the skin's own lane-header rule stands its mark down for exactly this reason
             ("a bullet that failed to load and got drawn twice"). A column head is subordinate to the group's
             name in any case, so the lighter weight is what it should have been. -->
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
            <!-- The verdicts are FACTS, which is precisely what `#meta` is for: it is already tabular, already
                 trailing, already shrink-0, so a column of them lines up down the list for free. -->
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
                    <!-- NARROW: the same two cells, carrying their own machine name because there is no head
                         above them to borrow one from. Same lookup, same words, so the two spellings of one
                         answer cannot drift apart. -->
                    <p class="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs @lg:hidden">
                        <span v-for="machine in MACHINES" :key="machine.locus">
                            <span class="text-subtle">{{ machine.label }} — </span>
                            <span :class="VERDICT_TONE[rule.tiers[machine.locus]]">{{ VERDICTS[rule.tiers[machine.locus]] }}</span>
                        </span>
                    </p>

                    <!-- THE CHIP AND ITS QUALIFIER ARE ONE FLEX ITEM, so a wrap can never leave "also -f and
                         --force-with-lease" stranded on the line under a chip it no longer sits beside. -->
                    <ul class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                        <li v-for="pattern in rule.patterns" :key="pattern.code" class="flex min-w-0 items-center gap-1.5">
                            <span class="inline-flex max-w-full items-center rounded border border-line-subtle bg-overlay px-1.5 py-0.5 text-2xs">
                                <RuleCommand :command="pattern.code" />
                            </span>
                            <span v-if="pattern.qualifier !== undefined" class="text-2xs text-subtle">{{ pattern.qualifier }}</span>
                        </li>
                    </ul>

                    <!-- THE ONE CLASS WHOSE MEANING IS THE ARGUMENT. "Delete a whole root directory" is not a
                         fact about a string, it is a fact about a machine, and the two answers are so different
                         (two paths here, an entire OS layout there) that stating only one would mislead
                         whichever reader it did not belong to. Railed, so it reads as a footnote to this row
                         rather than as a new row. -->
                    <div v-if="rule.notes !== undefined" class="flex flex-col gap-0.5 border-l border-line-subtle pl-2.5">
                        <p class="text-2xs text-muted">What counts as a root:</p>
                        <p v-for="machine in MACHINES" :key="machine.locus" class="text-2xs text-subtle">
                            <span class="text-muted">{{ machine.label }}</span> — {{ rule.notes[machine.locus] }}
                        </p>
                    </div>
                </div>
            </template>
        </Row>

        <!-- The one thing a reader of this list will otherwise get wrong, and the thing the old behaviour
             actually got wrong: a command that TALKS about a delete is not one. -->
        <RowNote>
            A command that only mentions one of these — printed by an <code class="font-mono text-content">echo</code>, searched for by a
            <code class="font-mono text-content">grep</code>, written into a heredoc — is not doing it, and never reaches the rules above.
        </RowNote>
    </RowGroup>
</template>
