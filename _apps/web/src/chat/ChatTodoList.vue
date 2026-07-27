<script setup lang="ts">
import type { IconName } from "@intentic-app/ui";
import type { TodoItem } from "@intentic/sandbox-contract";

/* The agent's task checklist (TodoWrite / the Task tool family) as it stood at ONE point in the turn.
 *
 * Every block in a transcript is a snapshot, not a live view: the agent writes a fresh one each time the list
 * moves, so a long turn leaves a trail of them and a finished session leaves the whole trail behind. Which is
 * why `live` exists — a spinner is a claim about right now, and the row that was underway when a snapshot was
 * taken stays that way forever. Scrolled back to, an animated row reads as an agent still working on a session
 * that ended hours ago; frozen, it keeps its highlight as a static dot and reads as the record it is. */

const props = defineProps<{
    todos: readonly TodoItem[];
    // Whether the bubble holding this snapshot is the one the turn is still streaming into.
    live: boolean;
}>();

const todoIcon = (todo: TodoItem): { name: IconName; spin?: boolean; class: string } => {
    if (todo.status === `completed`) {
        return { name: `check-circle`, class: `text-success` };
    }
    if (todo.status === `in_progress`) {
        return props.live ? { name: `spinner`, spin: true, class: `text-link` } : { name: `circle-fill`, class: `text-link` };
    }
    return { name: `circle`, class: `text-subtle` };
};

// `activeForm` is the row's present-tense phrasing ("Serializing…"), which only tells the truth while the row
// is actually active — a settled snapshot reads back in the same imperative form as the rows around it.
const todoText = (todo: TodoItem): string => (props.live && todo.status === `in_progress` && todo.activeForm ? todo.activeForm : todo.content);
</script>

<template>
    <div class="flex w-full flex-col gap-1 rounded-lg border border-line bg-overlay/40 px-3 py-2">
        <div v-for="(todo, index) in todos" :key="index" class="flex items-start gap-2 text-xs">
            <Icon v-bind="todoIcon(todo)" class="mt-0.5 text-2xs" />
            <span :class="{ 'text-subtle': todo.status === 'completed', 'line-through': todo.status === 'completed' }">{{ todoText(todo) }}</span>
        </div>
    </div>
</template>
