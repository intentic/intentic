<script setup lang="ts">
import { formatDayMonth } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, ref } from "vue";
import type { AgentHistoryEntry } from "../fleet/useAgentHistory";

// Where the agent's committed work went, as one line over the review list. The line names the newest commit and
// nothing else; the explanation, the full commit list and the way into the graph wait in a card that opens on hover,
// focus or tap. The card sits inside the strip's own box rather than being teleported, so the pointer can travel into
// it and click a commit, which a tooltip would not allow.

const {
    commits,
    unaccounted,
    remoteName = undefined,
    graphs,
} = defineProps<{
    commits: readonly AgentHistoryEntry[];
    unaccounted: number;
    remoteName?: string | undefined;
    // Per repository, how to open its commit graph; undefined where no graph is offered.
    graphs: ReadonlyMap<string, (() => void) | undefined>;
}>();
const emit = defineEmits<{ openGraph: [repo: string] }>();
const t = useT();

const lead = computed(() => commits[0]);
const whose = computed(() => (remoteName === undefined ? `your` : `${remoteName}'s`));

// Short delays either way: opening on a pointer merely crossing the strip would flash the card, and closing the
// instant the pointer leaves would make the gap between strip and card impassable.
const OPEN_DELAY = 150;
const CLOSE_DELAY = 200;
const open = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
const settle = (next: boolean, delay: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
        open.value = next;
    }, delay);
};
const toggle = (): void => {
    clearTimeout(timer);
    open.value = !open.value;
};
const close = (): void => {
    clearTimeout(timer);
    open.value = false;
};
// Keyboard reach: tabbing into the strip opens it, tabbing out past the card closes it.
const onFocusOut = (event: FocusEvent): void => {
    const into = event.relatedTarget as Node | null;
    if (into === null || !(event.currentTarget as HTMLElement).contains(into)) {
        close();
    }
};
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
    <div
        class="relative mx-2 mt-2 shrink-0"
        @mouseenter="settle(true, OPEN_DELAY)"
        @mouseleave="settle(false, CLOSE_DELAY)"
        @focusin="open = true"
        @focusout="onFocusOut"
        @keydown.esc="close"
    >
        <button
            type="button"
            class="flex h-7 w-full items-center gap-2 rounded-md border border-success/40 bg-success/10 px-2 text-left text-2xs transition-colors hover:bg-success/15"
            :aria-expanded="open"
            @click="toggle"
        >
            <span class="inline-flex shrink-0 items-center gap-1 font-medium text-success">
                <Icon name="check" class="text-2xs" />{{ t(`agents.agentReviewPanel.in`) }} {{ whose }} {{ t(`agents.agentReviewPanel.history`) }}
            </span>
            <template v-if="lead">
                <span class="shrink-0 rounded bg-overlay px-1 py-px font-mono text-muted">{{ lead.short }}</span>
                <span class="min-w-0 flex-1 truncate text-content">{{ lead.subject }}</span>
            </template>
            <span v-if="commits.length > 1" class="shrink-0 text-subtle">{{
                t(`agents.agentReviewPanel.moreCommits`, { count: commits.length - 1 }, commits.length - 1)
            }}</span>
            <Icon name="chevron-down" class="shrink-0 text-3xs text-subtle transition-transform" :class="open ? 'rotate-180' : ''" />
        </button>

        <!-- pt-1 rather than a margin: the padding is part of the hover box, so the pointer crosses into the card without leaving. -->
        <div v-show="open" class="absolute inset-x-0 top-full z-30 pt-1">
            <div class="flex max-h-80 flex-col gap-2 overflow-y-auto rounded-lg border border-line-strong bg-card p-3 shadow-lg">
                <p class="text-2xs leading-relaxed text-muted">{{ t(`agents.agentReviewPanel.committedWorkNotDifference`) }}</p>
                <ul class="flex flex-col gap-0.5">
                    <li v-for="commit in commits" :key="commit.sha">
                        <button
                            type="button"
                            class="group flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors"
                            :class="graphs.get(commit.repo) === undefined ? 'cursor-default' : 'hover:bg-overlay'"
                            :disabled="graphs.get(commit.repo) === undefined"
                            @click="emit('openGraph', commit.repo)"
                        >
                            <span class="mt-px shrink-0 rounded bg-overlay px-1 py-px font-mono text-2xs text-muted">{{ commit.short }}</span>
                            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span class="break-words text-xs text-content">{{ commit.subject }}</span>
                                <span class="text-2xs text-subtle">{{
                                    t(
                                        `agents.agentReviewPanel.commitLine`,
                                        { author: commit.author, when: formatDayMonth(commit.at), count: commit.changes.length },
                                        commit.changes.length,
                                    )
                                }}</span>
                            </span>
                            <span
                                v-if="graphs.get(commit.repo) !== undefined"
                                class="mt-px inline-flex shrink-0 items-center gap-1 text-2xs text-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                            >
                                <Icon name="sitemap" class="text-2xs" />{{ t(`agents.agentReviewPanel.gitHistory`) }}
                            </span>
                        </button>
                    </li>
                </ul>
                <!-- Absorbed but unattributable: reached main by no commit here; said explicitly, not silently dropped. -->
                <p v-if="unaccounted > 0" class="border-t border-line pt-2 text-2xs leading-relaxed text-subtle">
                    {{ t(`agents.agentReviewPanel.unaccounted`, { count: unaccounted }, unaccounted) }}
                </p>
            </div>
        </div>
    </div>
</template>
