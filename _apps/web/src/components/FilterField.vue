<script setup lang="ts">
import { useDevice } from "@intentic-app/ui";
import { ref } from "vue";

/* The one text filter, so the surfaces that carry it can't drift.
 *
 * Three of them do: the fleet board's header, the popped-out chat rail's, and (via the same props) any list
 * that wants the same gesture. They must agree on all of it — a filter that clears on Esc here and not there
 * is a filter the user stops trusting the moment they meet the second one.
 *
 * The leading glyph DOUBLES as the progress indicator rather than a spinner appearing beside it: this filter
 * answers locally on the first keystroke and from the daemon a beat later (see useAgentFilter), so "still
 * looking" is a normal state of a field that is already showing results, not a wait. It has to read as the
 * search icon thinking, not as a second control arriving. The workspace explorer's search box does the same.
 */

const value = defineModel<string>({ required: true });
const props = defineProps<{ placeholder: string; busy?: boolean; label: string }>();

const { mobile } = useDevice();
const input = ref<HTMLInputElement | undefined>(undefined);

// Esc clears without leaving the field — the caret stays where the next query gets typed. A second Esc is
// free to reach whatever else claims it (a dialog, the drag), which is why nothing is stopped here.
const onEscape = (): void => {
    value.value = ``;
};

const clear = (): void => {
    value.value = ``;
    input.value?.focus();
};

// Handed to the command that reveals this field: focus AND select, so a chord pressed with a stale query in
// the box starts a new one by typing rather than by clearing first (VS Code's find flow).
defineExpose({
    focus: (): void => {
        input.value?.focus();
        input.value?.select();
    },
});
</script>

<template>
    <div class="relative min-w-0">
        <Icon
            :name="props.busy === true ? `spinner` : `search`"
            :spin="props.busy === true"
            aria-hidden="true"
            class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-2xs text-subtle"
        />
        <!-- text, not search: the native type renders a second (unstyleable) clear affordance in WebKit beside
             the one below. text-base on touch is what stops iOS zooming the whole view on focus. -->
        <input
            ref="input"
            v-model="value"
            type="text"
            :aria-label="props.label"
            :placeholder="props.placeholder"
            class="w-full min-w-0 rounded-md border border-line bg-canvas py-1 pl-7 pr-7 text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
            :class="mobile ? 'h-9 text-base' : 'text-xs'"
            @keydown.esc="onEscape"
        />
        <button
            v-if="value !== ''"
            type="button"
            class="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center rounded text-2xs text-subtle transition-colors hover:text-content"
            v-tooltip.bottom="'Clear (Esc)'"
            aria-label="Clear filter"
            @click="clear"
        >
            <Icon name="times" />
        </button>
    </div>
</template>
