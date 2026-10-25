<script setup lang="ts">
import type { AgentRepoChanges } from "@intentic/sandbox-contract/schemas/git/git";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, useId } from "vue";

// What landing the work takes on, drawn under the review's bar (AgentReviewPanel): per manifest that gained any, the
// dependency names it declares now and did not before, labelled the way the rows are. This is where a new dependency
// is approved, since a conversation installs freely in its own copy.
//
// A line per manifest reads well for a few. Past that they fold into one line naming each dependency once, which opens
// onto where each one goes in a box of its own height: a dependency taken on across a monorepo (typescript into every
// package.json) once drew a line per package and pushed the file list and its diff off the screen.

const t = useT();

const { repos } = defineProps<{ repos: readonly AgentRepoChanges[] }>();

// Up to this many manifests are a line each.
const LINES = 3;

// A notice that needs no decision: one line under the bar, no box, so only the bar reads as something to act on.
const NOTE_LINE = `mx-2 mt-1.5 flex shrink-0 items-center gap-1.5 px-2 text-2xs text-muted`;

const manifests = computed(() =>
    repos.flatMap((group) =>
        (group.addedDependencies ?? []).map((manifest) => ({
            key: `${group.repo}\u0000${manifest.path}`,
            label: group.repo === `root` ? manifest.path : `${group.repo}/${manifest.path}`,
            added: manifest.added,
        })),
    ),
);
const folded = computed(() => manifests.value.length > LINES);

// The folded view turned inside out: each name once, with the manifests it goes into, most widespread first, since
// what the reader approves is a dependency, not a file.
const names = computed(() => {
    const where = new Map<string, string[]>();
    for (const manifest of manifests.value) {
        for (const name of manifest.added) {
            where.set(name, [...(where.get(name) ?? []), manifest.label]);
        }
    }
    return [...where].map(([name, into]) => ({ name, into })).sort((a, b) => b.into.length - a.into.length || a.name.localeCompare(b.name));
});
const namesLine = computed(() => names.value.map((entry) => entry.name).join(`, `));

const open = ref(false);
const listId = useId();
</script>

<template>
    <template v-if="folded">
        <!-- Nothing is wrong, so nothing is tinted. -->
        <div :class="NOTE_LINE">
            <Icon name="box" class="shrink-0 text-2xs text-subtle" />
            <span class="min-w-0 flex-1 truncate" v-tooltip.bottom.overflow="namesLine">{{
                t(`agents.agentReviewPanel.addsAcross`, { names: namesLine, count: manifests.length }, manifests.length)
            }}</span>
            <button
                type="button"
                class="inline-flex shrink-0 items-center gap-0.5 text-link underline-offset-2 hover:underline"
                :aria-expanded="open"
                :aria-controls="listId"
                @click="open = !open"
            >
                {{ open ? t(`agents.agentReviewPanel.hideManifests`) : t(`agents.agentReviewPanel.showManifests`) }}
                <Icon :name="open ? 'chevron-up' : 'chevron-down'" class="text-[0.6rem]" />
            </button>
        </div>
        <!-- Bounded and scrolled on its own, so opening it never costs the review its screen, nor the line above its toggle. -->
        <div
            v-if="open"
            :id="listId"
            class="mx-2 mt-1 max-h-48 shrink-0 overflow-y-auto rounded-md border border-line px-2 py-1.5 text-2xs"
        >
            <div v-for="entry in names" :key="entry.name" class="mb-1.5 last:mb-0">
                <div class="flex items-baseline gap-1.5">
                    <span class="font-mono text-content">{{ entry.name }}</span>
                    <span class="text-subtle">{{ t(`agents.agentReviewPanel.inManifests`, { count: entry.into.length }, entry.into.length) }}</span>
                </div>
                <!-- Wrapped rather than stacked: a name in ninety manifests is a few lines of paths, not ninety rows. -->
                <ul class="mt-1 flex flex-wrap gap-1">
                    <li
                        v-for="label in entry.into"
                        :key="label"
                        class="max-w-full truncate rounded bg-overlay px-1.5 py-px font-mono text-muted"
                        v-tooltip.bottom.overflow="label"
                    >
                        {{ label }}
                    </li>
                </ul>
            </div>
        </div>
    </template>
    <template v-else>
        <div v-for="manifest in manifests" :key="manifest.key" :class="NOTE_LINE">
            <Icon name="box" class="shrink-0 text-2xs text-subtle" />
            <span class="min-w-0 flex-1 truncate" v-tooltip.bottom.overflow="manifest.added.join(`, `)">{{
                t(`agents.agentReviewPanel.addsTo`, { names: manifest.added.join(`, `), manifest: manifest.label })
            }}</span>
        </div>
    </template>
</template>
