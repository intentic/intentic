<!-- THE ONE TEXT FILTER. Magnifier glyph, placeholder, type to narrow — in the two dresses that gesture wears:

     `panel` (default) is a scrolling panel's FIRST ROW — borderless, one rule under it, no label, because it is
     part of the panel rather than a field in a form (the model picker's, the design system's own PickerPanel's).
     `field` is the standalone bordered box that sits above a list it filters (the fleet board's header, the chat
     rail's). That second dress used to be a separate component, and a third, fourth and fifth spelling were
     hand-rolled — six implementations of one control, of which two zoomed the page on an iPhone and one drew a
     duplicate clear button in Safari.

     THE THREE DETAILS A HAND-ROLLED COPY GETS WRONG, all of them invisible on the machine it was written on:

     `text-base` below `md`. 16px is the threshold under which iOS Safari zooms the page when an input takes
     focus, and a panel that zooms the whole app the moment someone taps its filter is a bug you only ever see on
     a real phone.

     `type="text"`, never `type="search"`. WebKit draws its own unstyleable clear affordance for the search type,
     right beside the one this component draws, so the field ends up with two "×"s that look nothing alike.

     The busy glyph is the MAGNIFIER SPINNING, not a spinner arriving next to it. A filter that answers locally on
     the first keystroke and from the daemon a beat later is a field already showing results, not a field waiting
     — so "still looking" has to read as the search icon thinking rather than as a second control appearing.

     MATCH CASE is opt-in, by binding `v-model:matchCase` — the `Aa` switch every editor puts inside the field,
     in the glyph and the lit state the workspace search already uses, because a filter's switches are notation a
     user reads once and recognises everywhere. A bar whose caller has no case rule to flip simply doesn't draw
     it, and the room it takes is reserved only when it is there.

     Keyboard handling stays with the CALLER, except Escape when `clearable` is set (clearing IS the affordance
     the button offers, and the two must agree). The other keys mean different things to different panels — Enter
     picks a model in one and submits in another — and they bubble from the input to this component's root, so a
     `@keydown` on the tag reaches them all. `focus()` is exposed because a desktop panel claims the keyboard as
     it opens while a mobile sheet deliberately does not; `focus(true)` also selects, for the chord that REVEALS
     a filter that may still hold a stale query, so typing starts a new one rather than appending to the old. -->
<script setup lang="ts">
import { twMerge } from "tailwind-merge";
import { computed, ref, useAttrs } from "vue";
import Icon from "./Icon.vue";

defineOptions({ inheritAttrs: false });

const {
    placeholder = `Filter…`,
    variant = `panel`,
    clearable = false,
    busy = false,
} = defineProps<{
    placeholder?: string;
    /** panel: a panel's borderless first row; field: the standalone bordered box above a list. */
    variant?: `panel` | `field`;
    /** Offer a clear "×" once there is a query, and clear on Escape. */
    clearable?: boolean;
    /** Spin the magnifier — results are on screen and a slower source is still answering. */
    busy?: boolean;
    /** Names the field for assistive tech. A panel's bar is named by its panel; a standalone one needs its own. */
    ariaLabel?: string;
    /** The listbox this bar drives, for assistive tech — the row highlight lives there, not here. */
    ariaControls?: string;
    ariaActivedescendant?: string;
}>();

const query = defineModel<string>({ required: true });
/* The case rule the caller owns, and the switch's presence in one binding: a bar handed a boolean draws `Aa`,
 * a bar handed nothing has no case rule to offer and stays as it was. The switch is the state — no separate
 * "show it" prop to keep in step with the ref it would be describing. */
const matchCase = defineModel<boolean | undefined>(`matchCase`, { default: undefined });

// Class fallthrough lands on the root (the chrome), twMerge'd so a caller's `border-b-0` or `w-72` beats the
// variant base the way cmp.* overrides do — rather than depending on which utility Tailwind happened to emit last.
const attrs = useAttrs();
const passAttrs = computed(() => {
    const { class: _class, ...rest } = attrs;
    return rest;
});
const rootClass = computed(() =>
    twMerge(
        `relative min-w-0`,
        variant === `panel` ? `border-b border-line` : `rounded-md border border-line bg-canvas focus-within:border-line-strong`,
        typeof attrs[`class`] === `string` ? attrs[`class`] : ``,
    ),
);
/* Room on the right for the controls this bar actually has — none, the clear "×", or the `Aa` switch beside it.
 * Reserved by how many EXIST rather than how many are drawn: the clear button comes and goes with the query, and
 * a field whose text reflowed on the first keystroke would be a worse tell than the millimetres it saves.
 */
const RIGHT_ROOM = {
    panel: [``, `pr-8`, `pr-14`],
    field: [``, `pr-7`, `pr-12`],
} as const;
const controls = computed(() => (clearable ? 1 : 0) + (matchCase.value === undefined ? 0 : 1));
const inputClass = computed(() =>
    twMerge(
        `w-full min-w-0 bg-transparent text-base text-content placeholder:text-subtle focus:outline-none md:text-xs`,
        variant === `panel` ? `py-2 pl-9 pr-3` : `py-1 pl-7 pr-3 max-md:h-9`,
        RIGHT_ROOM[variant][controls.value] ?? ``,
    ),
);

const input = ref<HTMLInputElement | null>(null);
defineExpose({
    focus: (select = false): void => {
        input.value?.focus();
        if (select) {
            input.value?.select();
        }
    },
});

// Esc clears without leaving the field — the caret stays where the next query gets typed. A second Esc is free
// to reach whatever else claims it (a dialog, the drag), which is why nothing is stopped here.
const clear = (): void => {
    query.value = ``;
    input.value?.focus();
};
</script>

<template>
    <div :class="rootClass">
        <Icon
            :name="busy ? `spinner` : `search`"
            :spin="busy"
            aria-hidden="true"
            class="pointer-events-none absolute top-1/2 -translate-y-1/2 text-subtle"
            :class="variant === `panel` ? `left-3 text-xs` : `left-2 text-2xs`"
        />
        <input
            ref="input"
            v-bind="passAttrs"
            v-model="query"
            type="text"
            :placeholder="placeholder"
            :class="inputClass"
            role="searchbox"
            :aria-label="ariaLabel"
            :aria-controls="ariaControls"
            :aria-activedescendant="ariaActivedescendant"
            @keydown.esc="clearable && clear()"
        />
        <div class="absolute top-1/2 flex -translate-y-1/2 items-center gap-0.5" :class="variant === `panel` ? `right-2` : `right-1.5`">
            <!-- `Aa`, in the glyph and the lit state the workspace search uses — the notation IS the label, so it
                 is spelled out rather than iconified. `mousedown` is suppressed so a press leaves the caret in
                 the field it sits inside: the query is half typed and the next keystroke belongs to it. The click
                 still fires, so keyboard activation is untouched. -->
            <button
                v-if="matchCase !== undefined"
                type="button"
                class="flex h-4 w-4 items-center justify-center rounded font-mono text-[0.6rem] leading-none text-subtle transition-colors hover:bg-overlay hover:text-content"
                :class="{ 'bg-primary-600/20 text-link': matchCase }"
                :aria-pressed="matchCase"
                v-tooltip.bottom="'Match case'"
                aria-label="Match case"
                @mousedown.prevent
                @click="matchCase = !matchCase"
            >
                Aa
            </button>
            <button
                v-if="clearable && query !== ``"
                type="button"
                class="flex items-center rounded text-2xs text-subtle transition-colors hover:text-content"
                v-tooltip.bottom="'Clear (Esc)'"
                aria-label="Clear filter"
                @click="clear"
            >
                <Icon name="times" />
            </button>
        </div>
    </div>
</template>
