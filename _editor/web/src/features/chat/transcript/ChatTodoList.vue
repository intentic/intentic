<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import type { TodoItem } from "@intentic/sandbox-contract";

// A snapshot of the agent's task checklist (TodoWrite) at one point in the turn; the agent writes a fresh block each
// time the list changes. `live` marks the snapshot still being written: only it may animate, so a scrolled-back settled
// snapshot reads as a static record instead of work still in progress.

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

// activeForm is present-tense phrasing, true only while the row is actually active; a settled snapshot uses the
// imperative form instead.
const todoText = (todo: TodoItem): string => (props.live && todo.status === `in_progress` && todo.activeForm ? todo.activeForm : todo.content);
</script>

<template>
    <div class="flex w-full flex-col gap-1 px-3 py-2">
        <div v-for="(todo, index) in todos" :key="index" class="flex items-start gap-2 text-xs">
            <Icon v-bind="todoIcon(todo)" class="mt-0.5 text-2xs" />
            <span :class="{ 'text-subtle': todo.status === 'completed', 'line-through': todo.status === 'completed' }">{{ todoText(todo) }}</span>
        </div>
    </div>
</template>
