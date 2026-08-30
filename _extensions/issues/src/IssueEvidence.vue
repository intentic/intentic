<script setup lang="ts">
import type { IssueSummary } from "@intentic/sandbox-contract";
import { Code, formatTimestamp, ui } from "@intentic/extension-ui";
import { computed } from "vue";

/* THE EVIDENCE, opened under a row: the most recent occurrence in full.
 *
 * ORDERED BY WHAT A PERSON READS FIRST WHEN THEY ARE DECIDING WHAT TO DO, which is not the order the fields
 * arrive in. What a user wrote comes above the stack, because a sentence in somebody's own words is worth more
 * than any trace when there is one; the stack next, because that is where a fix starts; the breadcrumbs last,
 * because they are how you reproduce it once you have decided to.
 *
 * EVERYTHING HERE CAME FROM SOMEBODY ELSE'S BROWSER. It is rendered as text and never as markup, and the stack
 * goes in a <Code> block rather than a paragraph, which is both the readable choice and the one that cannot be
 * mistaken for the app talking. */

const { issue } = defineProps<{ issue: IssueSummary }>();

const sample = computed(() => issue.sample);
// Oldest first, the order they happened in, which is the order a person retraces them.
const breadcrumbs = computed(() => sample.value.breadcrumbs ?? []);
const context = computed(() => Object.entries(sample.value.context ?? {}));
const reporter = computed(() => {
    const who = sample.value.reporter;
    return [who?.name, who?.email].filter((part) => part !== undefined && part !== "").join(` · `);
});
</script>

<template>
    <div class="space-y-4 pt-1">
        <!-- What a person wrote, first and set as prose: it is the only part of this that somebody chose to say. -->
        <section v-if="sample.description !== undefined">
            <h3 :class="ui.sectionLabel(`mb-1`)">What they wrote</h3>
            <p class="max-w-read whitespace-pre-wrap">{{ sample.description }}</p>
            <!-- Labelled for what it is. Nobody signed anything to get here, and a name rendered without that
                 word is a name somebody could use to be believed. -->
            <p v-if="reporter !== ''" class="mt-1 text-sm text-muted">Says they are {{ reporter }} (unverified)</p>
        </section>

        <section>
            <h3 :class="ui.sectionLabel(`mb-1`)">The error</h3>
            <p class="max-w-read font-mono text-sm break-words">{{ sample.message }}</p>
            <!-- Clamped rather than scrolled in a box of its own: a framework stack runs to fifty frames, and
                 the section under it (what led up to the crash) is the one people actually scroll for. The kit's
                 clamp keeps the copy button working on the whole thing, so nothing is lost by folding it. -->
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
