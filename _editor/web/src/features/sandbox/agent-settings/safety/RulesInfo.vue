<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";

/* The (i) beside the Agent tab's "Rules" group. Two things a person needs before writing one and cannot get
 * from the form: what each moment can actually DO, they differ, and the differences are not arbitrary, and
 * how several rules at one moment relate to each other, which is the only thing about this table that is
 * surprising. */

const MOMENTS = [
    [`After it edits a file`, `Run a command on that file; what it prints on failure goes back with the edit`, `Once per edited file`],
    [`Before the assistant finishes`, `Send it back to work, or run something it has to pass`, `Once per turn`],
    [`Before you push`, `Run a command; the push waits on it`, `Once per push`],
    [`When an agent finishes`, `Land its work, or hold it on its branch`, `Once per finished agent`],
];
</script>

<template>
    <InfoDialog title="Rules">
        <p class="text-sm text-muted">
            A rule is a sentence: at this moment, if this is true, do this. It's how you tell the sandbox something once instead of remembering it
            every time.
        </p>
        <InfoTable class="mt-2" :headers="[`Moment`, `What a rule can do there`, `How often it runs`]" :rows="MOMENTS" />

        <!-- The one genuinely surprising thing: two moments here treat a list of rules differently, and the
             difference follows from what the moment is for rather than from a setting. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">When several rules match</h3>
        <div class="mt-2 grid gap-2 @lg:grid-cols-2">
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line-subtle bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">
                    Moments that do things
                </p>
                <p class="px-2.5 py-2 text-2xs text-muted">
                    Before a turn ends, and before a push: <span class="font-medium text-content">every</span> matching rule runs, in the order they
                    sit in the list. A push stops at the first one that fails: it isn't going anywhere, and the rest would only spend your time
                    saying so again.
                </p>
            </div>
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line-subtle bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">Moments that decide</p>
                <p class="px-2.5 py-2 text-2xs text-muted">
                    When an agent finishes there is one question: does this land, so the
                    <span class="font-medium text-content">first</span> matching rule answers it and the rest are not asked. Put your narrow rules
                    above your broad ones.
                </p>
            </div>
        </div>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Narrowing by path</h3>
        <p class="mt-1.5 text-2xs text-muted">
            Paths are written the way you'd write them in the search box: <span class="font-mono">docs/**</span>,
            <span class="font-mono">**/*.sql</span>, <span class="font-mono">api/src/**</span>, and read from your workspace root, so the same
            pattern means the same thing at every moment. A rule matches if the change touches any one of them.
        </p>
        <p class="mt-1.5 text-2xs text-subtle">
            With nothing here, a rule applies whenever its moment comes round. That is what the three rules above this group do: they're ordinary
            rules with a nicer switch, and you can see exactly what they wrote by turning one on and reading it back here.
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">When a rule does something</h3>
        <p class="mt-1.5 text-2xs text-muted">
            Anything that blocks a push, holds work back, or sends the assistant back to work is written to your activity feed with the rule's name on
            it, so "why won't my push go" has an answer on screen rather than in a log.
        </p>
        <p class="mt-1.5 text-2xs text-subtle">
            Each rule also shows when it last did anything. A rule that has never fired is either aimed at something that hasn't happened yet, or
            written wrong: worth a look either way.
        </p>
    </InfoDialog>
</template>
