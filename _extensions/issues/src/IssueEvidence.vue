<script setup lang="ts">
import type { IssueSummary } from "@intentic/sandbox-contract";
import { Code, formatTimestamp, ui } from "@intentic/extension-ui";
import { computed } from "vue";

// Evidence panel for one issue row: the most recent occurrence, in full. Fields are ordered by what a reader decides
// from first: description, then stack, then breadcrumbs. Rendered as text, never markup, since it all comes from
// someone else's browser.

const { issue } = defineProps<{ issue: IssueSummary }>();

const sample = computed(() => issue.sample);
// Breadcrumbs are oldest first, the order they happened in.
const breadcrumbs = computed(() => sample.value.breadcrumbs ?? []);
const context = computed(() => Object.entries(sample.value.context ?? {}));
const reporter = computed(() => {
    const who = sample.value.reporter;
    return [who?.name, who?.email].filter((part) => part !== undefined && part !== "").join(` · `);
});
</script>

<template>
    <div class="space-y-4 pt-1">
        <!-- What they wrote is shown first, as prose: the only part of this someone chose to say. -->
        <section v-if="sample.description !== undefined">
            <h3 :class="ui.sectionLabel(`mb-1`)">What they wrote</h3>
            <p class="max-w-read whitespace-pre-wrap">{{ sample.description }}</p>
            <!-- Labelled unverified: nobody signed in to submit this, so a name here could be impersonated. -->
            <p v-if="reporter !== ''" class="mt-1 text-sm text-muted">Says they are {{ reporter }} (unverified)</p>
        </section>

        <section>
            <h3 :class="ui.sectionLabel(`mb-1`)">The error</h3>
            <p class="max-w-read font-mono text-sm break-words">{{ sample.message }}</p>
            <!-- Clamped, not scrolled: a stack can run to dozens of frames; the clamp still keeps copy working on all of it. -->
            <Code v-if="sample.stack !== undefined" :code="sample.stack" :clamp-lines="14" copyable class="mt-2" />
        </section>

        <section v-if="breadcrumbs.length > 0">
            <h3 :class="ui.sectionLabel(`mb-1`)">Just before it</h3>
            <ol class="space-y-0.5 text-sm">
                <li v-for="(crumb, index) in breadcrumbs" :key="index" class="flex gap-2">
                    <span class="w-32 shrink-0 text-muted tabular-nums">{{ formatTimestamp(crumb.at) }}</span>
                    <span class="w-24 shrink-0 text-muted">{{ crumb.kind }}</span>
                    <span class="min-w-0 break-words">{{ crumb.message }}</span>
                </li>
            </ol>
        </section>

        <section v-if="context.length > 0 || sample.userAgent !== undefined">
            <h3 :class="ui.sectionLabel(`mb-1`)">Where</h3>
            <!-- `grid-cols-facts` is the shared label/value grid class; extensions can't use an inline arbitrary column value. -->
            <dl class="grid grid-cols-facts gap-x-3 gap-y-0.5 text-sm">
                <template v-if="sample.url !== undefined">
                    <dt class="text-muted">Page</dt>
                    <dd class="min-w-0 break-all">{{ sample.url }}</dd>
                </template>
                <template v-if="sample.userAgent !== undefined">
                    <dt class="text-muted">Browser</dt>
                    <dd class="min-w-0 break-words">{{ sample.userAgent }}</dd>
                </template>
                <template v-for="[key, value] in context" :key="key">
                    <dt class="text-muted">{{ key }}</dt>
                    <dd class="min-w-0 break-words">{{ value }}</dd>
                </template>
            </dl>
        </section>
    </div>
</template>
