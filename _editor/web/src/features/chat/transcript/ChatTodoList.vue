<script setup lang="ts">
import { computed, ref } from "vue";
import type { IconName } from "@intentic/ui";
import type { TodoItem } from "@intentic/sandbox-contract/events/requests";
import type { ChecklistView } from "../../../models/conversations/transcript/transcript";
import { useT } from "@intentic/ui/i18n";

// A snapshot of the agent's task checklist (TaskCreate/TaskUpdate) at one point in the turn. The daemon rebuilds the
// whole list on every status flip, so only a turn's first and last snapshots draw the list — the plan and where it
// ended; the rest draw one line for what moved and open to the same rows, as ChatToolRun opens to ChatToolRows. Every
// line one of them states is a MOVE, never a level: the reader gets the level from the list under it. `live` marks the
// snapshot still being written: only it may animate, so a scrolled-back settled snapshot reads as a static record
// instead of work still in progress.

const t = useT();

const props = defineProps<{
    todos: readonly TodoItem[];
    // Whether the bubble holding this snapshot is the one the turn is still streaming into.
    live: boolean;
    // Absent draws the list in full, so a snapshot the projection didn't map degrades to the unabridged rendering.
    view?: ChecklistView;
    // The side rail's scale: same rows, one step down, so a 240px column doesn't read as a second type system.
    dense?: boolean;
    // The rail's list flowed down two columns, each as wide as the rail's one (ChatRailChecklist), so no row rewraps.
    spread?: boolean;
}>();

const delta = computed(() => (props.view?.kind === `delta` ? props.view : undefined));

const todoIcon = (todo: TodoItem): { name: IconName; spin?: boolean; class: string } => {
    if (todo.status === `completed`) {
        return { name: `check-circle`, class: `text-success` };
    }
    if (todo.status === `in_progress`) {
        return props.live ? { name: `spinner`, spin: true, class: `text-link` } : { name: `circle-fill`, class: `text-link` };
    }
    return { name: `circle`, class: `text-subtle` };
};

// activeForm is present-tense phrasing, true only while the row is actually active; a settled snapshot uses the
// imperative form instead.
const todoText = (todo: TodoItem): string => (props.live && todo.status === `in_progress` && todo.activeForm ? todo.activeForm : todo.content);

// Tasks entering or leaving the list mid-turn: the one change the finished/started pair cannot say.
const churn = computed(() => {
    const moved = delta.value;
    if (moved === undefined) {
        return undefined;
    }
    const parts = [...(moved.added > 0 ? [`+${moved.added}`] : []), ...(moved.dropped > 0 ? [`−${moved.dropped}`] : [])];
    return parts.length === 0 ? undefined : parts.join(` `);
});

// An ADVANCE, never a level: a bare "3/5" sits where a status bar puts what is true now, and every one of these rows
// is a stamp from earlier in the turn. Absent where the count held, so the figure can only ever mean movement.
const advance = computed(() => {
    const moved = delta.value;
    return moved === undefined || moved.done === moved.doneBefore
        ? undefined
        : t(`chat.chatTodoList.advance`, { before: moved.doneBefore, done: moved.done, total: moved.total });
});

// The line as a sentence, for hover and screen readers: icons and an arrow say none of this out loud.
const summary = computed(() => {
    const moved = delta.value;
    if (moved === undefined) {
        return ``;
    }
    const said = [
        ...moved.finished.map((item) => t(`chat.chatTodoList.finished`, { content: item.content })),
        ...moved.started.map((item) => t(`chat.chatTodoList.started`, { content: item.content })),
        ...moved.parked.map((item) => t(`chat.chatTodoList.leftOpen`, { content: item.content })),
        ...(moved.added > 0 ? [t(`chat.chatTodoList.added`, { count: moved.added })] : []),
        ...(moved.dropped > 0 ? [t(`chat.chatTodoList.dropped`, { count: moved.dropped })] : []),
    ].join(`, `);
    // "still" and "at this point" are the words that stop a past snapshot reading as the checklist's state now.
    const progress =
        advance.value === undefined
            ? t(`chat.chatTodoList.stillDone`, { done: moved.done, total: moved.total })
            : t(`chat.chatTodoList.doneAtPoint`, { before: moved.doneBefore, done: moved.done, total: moved.total });
    return `${said}${said === `` ? `` : ` · `}${progress}`;
});

const expanded = ref(false);
const toggle = (): void => {
    expanded.value = !expanded.value;
};
const hint = computed(() =>
    expanded.value ? t(`chat.chatTodoList.hide`, { summary: summary.value }) : t(`chat.chatTodoList.show`, { summary: summary.value }),
);
</script>

<template>
    <div class="flex w-full flex-col">
        <!-- One line for the change, at the list's own indent and text size: it stands in for rows, so it reads as one. -->
        <!-- A META ROW (chat.css `.chat-meta`): its first glyph in the mark box on the column's edge, its words on the hang,
             where a notice's and a background job's stand. -->
        <button
            v-if="delta"
            type="button"
            class="chat-meta group/todo flex w-full items-center gap-2 rounded-md py-1 pr-3 text-left text-2xs transition-colors hover:bg-overlay max-md:py-2.5"
            :aria-expanded="expanded"
            :aria-label="hint"
            @click="toggle"
        >
            <!-- No strikethrough here, unlike the row it stands for: this is the news that it got done, not a settled row. -->
            <template v-if="delta.finished.length > 0">
                <span class="chat-mark"><Icon name="check-circle" class="text-xs text-success" /></span>
                <span class="min-w-0 truncate text-muted">{{ delta.finished[0]!.content }}</span>
                <span v-if="delta.finished.length > 1" class="shrink-0 text-2xs text-subtle">+{{ delta.finished.length - 1 }}</span>
            </template>

            <template v-if="delta.started.length > 0">
                <Icon v-if="delta.finished.length > 0" name="arrow-right" class="shrink-0 text-2xs text-subtle" />
                <span v-if="delta.finished.length === 0" class="chat-mark"><Icon v-bind="todoIcon(delta.started[0]!)" class="text-xs" /></span>
                <Icon v-else v-bind="todoIcon(delta.started[0]!)" class="shrink-0 text-2xs" />
                <span class="min-w-0 truncate text-content">{{ todoText(delta.started[0]!) }}</span>
            </template>

            <!-- The move the finished/started pair cannot state, and the reason the figure beside it can hold still. Marked with a
     glyph from outside the list's own three, since this is an annotation on the line and not a row of the checklist. -->
            <template v-if="delta.parked.length > 0">
                <Icon name="clock" class="shrink-0 text-2xs text-subtle" />
                <span class="min-w-0 truncate text-subtle">{{ t(`chat.chatTodoList.stillOpen`, { content: delta.parked[0]!.content }) }}</span>
                <span v-if="delta.parked.length > 1" class="shrink-0 text-2xs text-subtle">+{{ delta.parked.length - 1 }}</span>
            </template>

            <span v-if="churn" class="shrink-0 text-2xs tabular-nums text-subtle">{{ churn }}</span>

            <!-- The advance is the one number worth keeping when the line truncates, so it is pinned to the far edge. -->
            <span v-if="advance" class="ml-auto shrink-0 text-2xs tabular-nums text-subtle group-hover/todo:text-muted">{{ advance }}</span>
        </button>

        <!-- Opened, the delta shows the same rows the full mode draws; there is no second rendering of a checklist. -->
        <Transition name="chat-run-reveal">
            <div v-if="delta === undefined || expanded" class="grid">
                <div class="min-h-0 overflow-hidden">
                    <!-- In a transcript, a META ROW per task: the circle in the mark box on the column's edge, the task on the hang,
                         and the meta tier's size — a tier under the answer, so a checklist redrawn every few calls never
                         out-shouts the words it is tracking. -->
                    <!-- Dense, each row carries its own gap below it, so the rows' heights add up to the list's in one column
                         whichever way it is drawn (railChecklistSpread.ts), and a row never splits across two columns. -->
                    <div
                        class="w-full"
                        :class="dense ? (spread ? 'columns-2 gap-x-6' : 'flex flex-col') : 'chat-meta flex flex-col gap-1 py-1'"
                    >
                        <!-- A row the rail's checklist plays in (`data-reveal`, ChatRailChecklist); inert in a transcript, which reveals nothing. -->
                        <div
                            v-for="(todo, index) in todos"
                            :key="index"
                            class="flex items-start gap-2 text-2xs"
                            :class="dense && 'break-inside-avoid pb-1.5 last:pb-0'"
                            data-reveal
                        >
                            <Icon v-if="dense" v-bind="todoIcon(todo)" class="mt-0.5 text-3xs" />
                            <span v-else class="chat-mark"><Icon v-bind="todoIcon(todo)" class="text-xs" /></span>
                            <!-- Three inks for three states: done recedes, open waits a step down, and the one in hand reads at full ink.
                                 The tick already says done, so no strikethrough rules a line through every settled row. -->
                            <span
                                :class="{
                                    'text-subtle': todo.status === 'completed',
                                    'text-muted': todo.status === 'pending',
                                    'text-content': todo.status === 'in_progress',
                                }"
                                >{{
                                todoText(todo)
                            }}</span>
                        </div>
                    </div>
                </div>
            </div>
        </Transition>
    </div>
</template>
