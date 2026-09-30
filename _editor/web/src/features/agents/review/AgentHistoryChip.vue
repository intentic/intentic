<script setup lang="ts">
import { formatDayMonth } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, ref } from "vue";
import type { AgentHistoryEntry } from "../fleet/useAgentHistory";

// Where the agent's committed work went, as the same small commit pill the diff toolbar shows, sitting in the file
// list's header rather than taking a row of its own. The explanation, the full commit list and the way into the graph
// wait in a card that opens to the right of the list on hover, focus or tap. The card is teleported to escape the panel's clipping, and is
// interactive (unlike a tooltip) so a commit in it can be clicked.

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
// The pill carries only the SHA, so the card says what it is.
const heading = computed(() => `${t(`agents.agentReviewPanel.in`)} ${whose.value} ${t(`agents.agentReviewPanel.history`)}`);

const WIDTH = 384;
const GAP = 8;
const trigger = ref<HTMLElement | null>(null);
const card = ref<HTMLElement | null>(null);
const placement = ref<{ left: number; top: number; maxHeight: number }>();

// Right of the list the pill heads (the diff lies that way, and the list's rows stay readable), then left of it for
// a panel at the window's right edge, then under the pill when neither side has room (a phone).
const place = (): void => {
    const el = trigger.value;
    if (el === null) {
        return;
    }
    const win = el.ownerDocument.defaultView ?? globalThis;
    const rect = el.getBoundingClientRect();
    const column = el.closest(`aside`)?.getBoundingClientRect() ?? rect;
    const top = Math.max(GAP, rect.top - 4);
    if (win.innerWidth - column.right - GAP * 2 >= WIDTH) {
        placement.value = { left: column.right + GAP, top, maxHeight: win.innerHeight - top - GAP };
    } else if (column.left - GAP * 2 >= WIDTH) {
        placement.value = { left: column.left - GAP - WIDTH, top, maxHeight: win.innerHeight - top - GAP };
    } else {
        const below = rect.bottom + GAP;
        placement.value = { left: Math.max(GAP, Math.min(rect.left, win.innerWidth - WIDTH - GAP)), top: below, maxHeight: win.innerHeight - below - GAP };
    }
};

// Short delays either way: opening on a pointer merely crossing the pill would flash the card, and closing the instant
// the pointer leaves gives it time to reach the card beside the list.
const OPEN_DELAY = 150;
const CLOSE_DELAY = 200;
let timer: ReturnType<typeof setTimeout> | undefined;
const show = (): void => {
    clearTimeout(timer);
    place();
};
const close = (): void => {
    clearTimeout(timer);
    placement.value = undefined;
};
const settle = (next: boolean, delay: number): void => {
    clearTimeout(timer);
    timer = setTimeout(next ? show : close, delay);
};
const toggle = (): void => (placement.value === undefined ? show() : close());
// Keyboard reach: tabbing onto the pill opens the card, tabbing out of both the line and the card closes it.
const onFocusOut = (event: FocusEvent): void => {
    const into = event.relatedTarget as Node | null;
    if (into === null || !(trigger.value?.contains(into) || card.value?.contains(into))) {
        close();
    }
};
onBeforeUnmount(close);
</script>

<template>
    <span class="inline-flex shrink-0">
        <button
            ref="trigger"
            type="button"
            class="inline-flex shrink-0 items-center gap-1 ui-status-pill bg-success/15 font-mono text-2xs font-medium text-success transition-colors hover:bg-success/25"
            :aria-expanded="placement !== undefined"
            :aria-label="heading"
            @mouseenter="settle(true, OPEN_DELAY)"
            @mouseleave="settle(false, CLOSE_DELAY)"
            @focusin="show"
            @focusout="onFocusOut"
            @keydown.esc="close"
            @click="toggle"
        >
            <Icon name="check" class="text-2xs" />{{ lead?.short
            }}<span v-if="commits.length > 1" class="font-sans font-normal opacity-80">+{{ commits.length - 1 }}</span>
        </button>

        <Teleport to="body">
            <div
                v-if="placement"
                ref="card"
                class="fixed z-50 flex flex-col gap-2 overflow-y-auto rounded-lg border border-line-strong bg-card p-3 shadow-lg"
                :style="{ left: `${placement.left}px`, top: `${placement.top}px`, width: `${WIDTH}px`, maxHeight: `${placement.maxHeight}px` }"
                @mouseenter="settle(true, 0)"
                @mouseleave="settle(false, CLOSE_DELAY)"
                @focusout="onFocusOut"
                @keydown.esc="close"
            >
                <div class="flex flex-col gap-1">
                    <p class="inline-flex items-center gap-1 text-xs font-medium text-success"><Icon name="check" class="text-2xs" />{{ heading }}</p>
                    <p class="text-2xs leading-relaxed text-muted">{{ t(`agents.agentReviewPanel.committedWorkNotDifference`) }}</p>
                </div>
                <ul class="-mx-1.5 flex flex-col gap-0.5">
                    <li v-for="commit in commits" :key="commit.sha">
                        <button
                            type="button"
                            class="group flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors"
                            :class="graphs.get(commit.repo) === undefined ? 'cursor-default' : 'hover:bg-overlay'"
                            :disabled="graphs.get(commit.repo) === undefined"
                            @click="emit('openGraph', commit.repo)"
                        >
                            <span class="mt-px shrink-0 font-mono text-2xs text-subtle">{{ commit.short }}</span>
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
                            <Icon
                                v-if="graphs.get(commit.repo) !== undefined"
                                name="sitemap"
                                class="mt-0.5 shrink-0 text-2xs text-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                            />
                        </button>
                    </li>
                </ul>
                <!-- Absorbed but unattributable: reached main by no commit here; said explicitly, not silently dropped. -->
                <p v-if="unaccounted > 0" class="border-t border-line pt-2 text-2xs leading-relaxed text-subtle">
                    {{ t(`agents.agentReviewPanel.unaccounted`, { count: unaccounted }, unaccounted) }}
                </p>
            </div>
        </Teleport>
    </span>
</template>
