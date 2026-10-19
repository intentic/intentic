<!-- The app's one search field, in `panel` (a popover's borderless first band) or `field` (a soft, filled box above a list) dress. -->
<script setup lang="ts">
import { twMerge } from "tailwind-merge";
import { computed, onBeforeUnmount, onMounted, ref, useAttrs, watch } from "vue";
import Icon from "../primitives/Icon.vue";
import type { IconName } from "../../icons/iconSets.js";
import { isOverlayTarget, isTypingTarget } from "../../lib/eventTarget.js";
import { useT } from "../../i18n/index.js";

const t = useT();

defineOptions({ inheritAttrs: false });

const {
    placeholder,
    variant = `panel`,
    dense = false,
    icon = `search`,
    clearable = false,
    busy = false,
    shortcut,
} = defineProps<{
    placeholder?: string;
    /** panel: a popover's borderless first band (the default); field: the filled box above a list or in a toolbar. */
    variant?: `panel` | `field`;
    /** A field for a toolbar row, 28px tall where the default is 32px. A field only: a band is as tall as its panel's rows. */
    dense?: boolean;
    /** What the field asks for, when it is not a search: a folder for the files to include, say. */
    icon?: IconName;
    /** Offer a clear "×" once there is a query, and clear on Escape. */
    clearable?: boolean;
    /** Spin the magnifier: results are on screen and a slower source is still answering. */
    busy?: boolean;
    /** One key that reaches the field from anywhere on the page (`/`), drawn as a keycap while the field is idle. */
    shortcut?: string;
    /** Names the field for assistive tech. A panel's bar is named by its panel; a standalone one needs its own. */
    ariaLabel?: string;
    /** The listbox this bar drives, for assistive tech: the row highlight lives there, not here. */
    ariaControls?: string;
    ariaActivedescendant?: string;
}>();

const emit = defineEmits<{
    /** The query was cleared from the field's own "×" or Escape, for a caller that resets more than the words. */
    clear: [];
}>();

const query = defineModel<string>({ required: true });
// Presence doubles as the switch: undefined offers no case rule, a boolean draws `Aa` and is the state itself.
const matchCase = defineModel<boolean | undefined>(`matchCase`, { default: undefined });

// Fallthrough class lands on the root, twMerge'd so a caller's override always beats the dress; everything else
// (listeners, `name`, `autofocus`) lands on the input, which is what a caller binding `@keydown` means.
const attrs = useAttrs();
const passAttrs = computed(() => {
    const { class: _class, ...rest } = attrs;
    return rest;
});

// The look lives in utilities.css (`ui-search`, `ui-search-band`), not here, so a skin re-points one rule instead of
// chasing utility strings; the component only says which dress, and how tall.
const rootClass = computed(() =>
    twMerge(
        `group/search flex min-w-0 items-center`,
        variant === `panel` ? `ui-search-band gap-2.5 px-3` : [`ui-search gap-2 pl-2.5 pr-1`, dense ? `h-7` : `h-8 max-md:h-10`],
        typeof attrs[`class`] === `string` ? attrs[`class`] : ``,
    ),
);

const searching = computed(() => query.value !== ``);

const input = ref<HTMLInputElement | null>(null);
const focus = (select = false): void => {
    input.value?.focus();
    if (select) {
        input.value?.select();
    }
};
defineExpose({ focus });

// Esc clears without leaving the field; not stopped, so a second Esc still reaches whatever else claims it.
// The caret stays in the field, and the caller hears of it after that, so one that hands the keyboard elsewhere on a clear
// (a page that gives its own keys back) has the last word.
const clear = (): void => {
    query.value = ``;
    input.value?.focus();
    emit(`clear`);
};

// A press anywhere on the box (the magnifier, the padding round the words) is a press on the field: the box is what
// reads as the field, and a dead ring round the real one is the commonest way a search looks broken.
const onBoxDown = (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest(`input, button`) === null) {
        event.preventDefault();
        focus();
    }
};

// The shortcut reaches the field from anywhere on the page, as `/` does on most sites with one search. Never from a
// field or an open overlay, which own their keys, and never with a modifier, which is someone's chord.
// A layout that mounts the same search twice (a hub's rail and its narrow strip) answers once, from the one on screen.
const onPageKey = (event: KeyboardEvent): void => {
    if (event.key !== shortcut || event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target) || isOverlayTarget(event.target)) {
        return;
    }
    if (event.defaultPrevented || input.value === null || input.value.getClientRects().length === 0) {
        return;
    }
    event.preventDefault();
    focus(true);
};
let listening = false;
const listen = (on: boolean): void => {
    if (on === listening) {
        return;
    }
    if (on) {
        window.addEventListener(`keydown`, onPageKey);
    } else {
        window.removeEventListener(`keydown`, onPageKey);
    }
    listening = on;
};
onMounted(() => listen(shortcut !== undefined));
watch(
    () => shortcut,
    (key) => listen(key !== undefined),
);
onBeforeUnmount(() => listen(false));
</script>

<template>
    <div :class="rootClass" @mousedown="onBoxDown">
        <Icon
            :name="busy ? `spinner` : icon"
            :spin="busy"
            aria-hidden="true"
            class="ui-search-icon pointer-events-none shrink-0"
            :class="variant === `panel` ? `text-sm` : `text-xs`"
        />
        <!-- allow(inputs): THE FRAME IS THE ROW'S, not the input's: `ui-search` / `ui-search-band` on the box above draws the fill,
             the edge and the one focus state (utilities.css), and the input is `field-bare` inside it, as a field in a
             `ui-field-shell` is. Its height is the row's, so it carries no padding of its own. -->
        <input
            ref="input"
            v-bind="passAttrs"
            v-model="query"
            type="text"
            :placeholder="placeholder ?? t(`ui.action.filter`)"
            class="field-bare h-full min-w-0 flex-1 self-stretch md:text-xs"
            :class="variant === `panel` ? `py-2.5` : ``"
            role="searchbox"
            enterkeyhint="search"
            autocomplete="off"
            spellcheck="false"
            :aria-label="ariaLabel"
            :aria-controls="ariaControls"
            :aria-activedescendant="ariaActivedescendant"
            :aria-keyshortcuts="shortcut"
            @keydown.esc="clearable && clear()"
        />
        <!-- `mousedown` is suppressed on every control here so a press keeps the caret in the field rather than stealing it; click still fires for keyboard activation. -->
        <div v-if="$slots[`controls`] || matchCase !== undefined" class="flex shrink-0 items-center gap-0.5" @mousedown.prevent>
            <slot name="controls" />
            <button
                v-if="matchCase !== undefined"
                type="button"
                class="ui-search-toggle"
                :aria-pressed="matchCase"
                v-tooltip.bottom="t(`ui.searchBar.matchCase`)"
                :aria-label="t(`ui.searchBar.matchCase`)"
                @click="matchCase = !matchCase"
            >
                {{ t(`ui.searchBar.aa`) }}
            </button>
        </div>
        <!-- The clear chip keeps its place while it is hidden, so the words never reflow under the caret as the query comes and goes. -->
        <button
            v-if="clearable"
            v-show="searching"
            type="button"
            class="ui-search-clear"
            v-tooltip.bottom="{ title: t(`ui.action.clear`), keys: t(`ui.keys.esc`) }"
            :aria-label="t(`ui.action.clearFilter`)"
            @mousedown.prevent
            @click="clear"
        >
            <Icon name="times" />
        </button>
        <!-- A keycap, drawn as a key: shown only while the field is idle (not focused, nothing typed) and never on a touch
             screen, which has no key to press. It says what it is for on hover; the field says it to assistive tech. -->
        <kbd
            v-if="shortcut !== undefined && !searching"
            class="ui-keycap mr-1 group-focus-within/search:hidden max-md:hidden pointer-coarse:hidden"
            v-tooltip.bottom="{ title: t(`ui.searchBar.search`), keys: shortcut }"
            >{{ shortcut }}</kbd
        >
    </div>
</template>
