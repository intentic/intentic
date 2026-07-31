<script setup lang="ts">
import { probeSpec } from "@intentic/sandbox-contract/chores";
import { Icon, timeAgo } from "@intentic/extension-ui";
import type { ProbeResult } from "@intentic/sandbox-contract";
import { computed } from "vue";

/* WHAT WE MEASURED, AND WHEN. A strip above each repository's chores rather than a detail buried inside them,
 * because it answers the question a reader has before they trust any row: is this current?
 *
 * Probes refresh on a daily-to-weekly TTL, so "clean" from a measurement taken last Tuesday is a genuinely
 * different claim from "clean" as of an hour ago, and a panel that showed only the verdict would be quietly
 * passing off the one as the other. Naming the age here — once per repository, in small type — costs a line and
 * makes every chore below it honest.
 *
 * A probe that could not run says so in the same strip. "knip is not a devDependency of this repository" belongs
 * next to the measurements, not hidden inside the one chore that happens to need it: it is a fact about what this
 * surface can see, and a reader deciding whether the list below is complete needs it up front. */

const { probes } = defineProps<{ probes: readonly ProbeResult[]; busy: boolean }>();
const emit = defineEmits<{ refresh: [id: string] }>();

const entries = computed(() =>
    probes.map((probe) => {
        const spec = probeSpec(probe.id);
        return {
            probe,
            title: spec.title,
            measures: spec.measures,
            // A tier-2 probe can run for minutes, so the reader gets told what they are asking for before they
            // press the button rather than after the sandbox goes quiet.
            cost: spec.tier === 2 ? ` · takes a few minutes` : ``,
        };
    }),
);
</script>

<template>
    <div v-if="entries.length > 0" class="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line/60 px-4 py-2">
        <span class="text-2xs text-subtle">measured</span>
        <div v-for="entry in entries" :key="entry.probe.id" class="flex items-center gap-1.5">
            <Icon
                :name="entry.probe.state === `ok` ? `check-circle` : entry.probe.state === `unavailable` ? `circle` : `exclamation-circle`"
                class="text-2xs"
                :class="entry.probe.state === `failed` ? `text-warning` : `text-subtle`"
            />
            <span class="text-2xs text-content">{{ entry.title }}</span>
            <span class="text-2xs text-subtle">
                {{ entry.probe.state === `ok` ? timeAgo(entry.probe.ranAt) : (entry.probe.reason ?? entry.probe.state) }}
            </span>
            <button
                type="button"
                class="cursor-pointer text-subtle hover:text-content disabled:cursor-default disabled:opacity-40"
                :disabled="busy"
                :title="`Measure ${entry.measures} again now${entry.cost}`"
                @click="emit(`refresh`, entry.probe.id)"
            >
                <Icon name="refresh" class="text-2xs" />
            </button>
        </div>
    </div>
</template>
