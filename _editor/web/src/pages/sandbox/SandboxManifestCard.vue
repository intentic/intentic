<script setup lang="ts">
import { Card, Row, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import { useManifestProblems } from "../../composables/sandbox/useManifestProblems";

/* "Something in your settings files isn't being read": the companion to SandboxBehindCard.
 *
 * That card is about a mismatch between this app and the sandbox's build. This one is about the sandbox's own
 * state files: it read them, something in them didn't make sense, and it carried on with defaults. Both are
 * non-blocking notices about a thing that is quietly not working, which is why they sit together; they are
 * separate cards because the remedies have nothing in common: one is "update the sandbox", the other is
 * "there's a typo on line 12".
 *
 * Everything here is per FILE, because the file is the unit someone opens to fix it. */

const { reports, hasProblems } = useManifestProblems();

const problemCount = computed(() => reports.value.reduce((total, report) => total + report.problems.length, 0));

// One line per problem, in the words of someone who has to go and fix it: never a schema path or a parser
// dump. The suggestion is the whole point of the misspelling case and is omitted when nothing was close
// enough to guess: a confident wrong guess sends someone to edit a line that was never the problem.
const describe = (problem: { kind: string; detail: string; suggestion?: string }): string => {
    if (problem.kind === `unreadable`) {
        return `The whole file is being ignored: ${problem.detail}. Every setting in it is back at its default.`;
    }
    if (problem.kind === `unknownKey`) {
        const guess = problem.suggestion === undefined ? `` : ` Did you mean "${problem.suggestion}"?`;
        return `"${problem.detail}" isn't a setting this sandbox knows, so it's being ignored.${guess}`;
    }
    return `One entry was skipped: ${problem.detail}`;
};
</script>

<template>
    <Card v-if="hasProblems" class="flex flex-col gap-4">
        <Row
            flush
            :heading="2"
            icon="info-circle"
            title="Some settings aren't being applied"
            description="This sandbox read its settings files and couldn't make sense of part of them, so it fell back to defaults there. Everything else is unaffected, and fixing the file puts this right on its own."
        >
            <template #meta><StatusBadge variant="warning" :label="`${problemCount} to fix`" dot /></template>
        </Row>

        <div v-for="report in reports" :key="report.path" class="flex flex-col gap-1">
            <p class="font-mono text-2xs text-content">{{ report.path }}</p>
            <p v-for="(problem, index) in report.problems" :key="index" class="text-2xs text-subtle">{{ describe(problem) }}</p>
        </div>
    </Card>
</template>
