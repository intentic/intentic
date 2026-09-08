<!--
    The app's one text filter, in `panel` (a panel's borderless first row) or `field` (a standalone bordered box) dress. Uses `text-base` below `md`
    to dodge iOS Safari's zoom-on-focus, and `type="text"` to dodge WebKit's own clear button. `matchCase` adds the `Aa` case-sensitivity switch.
-->
<script setup lang="ts">
import { twMerge } from "tailwind-merge";
import { computed, ref, useAttrs } from "vue";
import Icon from "../primitives/Icon.vue";

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
    /** Spin the magnifier: results are on screen and a slower source is still answering. */
    busy?: boolean;
    /** Names the field for assistive tech. A panel's bar is named by its panel; a standalone one needs its own. */
    ariaLabel?: string;
    /** The listbox this bar drives, for assistive tech: the row highlight lives there, not here. */
    ariaControls?: string;
    ariaActivedescendant?: string;
}>();

const query = defineModel<string>({ required: true });
// Presence doubles as the switch: undefined offers no case rule, a boolean draws `Aa` and is the state itself.
const matchCase = defineModel<boolean | undefined>(`matchCase`, { default: undefined });

// Fallthrough class lands on the root, twMerge'd so a caller's override always beats the variant base.
const attrs = useAttrs();
const passAttrs = computed(() => {
    const { class: _class, ...rest } = attrs;
    return rest;
});
const rootClass = computed(() =>
    twMerge(
        `ui-search-row relative min-w-0`,
        variant === `panel` ? `border-b border-line` : `rounded-md border border-line bg-canvas`,
        typeof attrs[`class`] === `string` ? attrs[`class`] : ``,
    ),
);
// Right padding reserved by how many controls exist, not drawn, so text doesn't reflow as the query changes.
const RIGHT_ROOM = {
    panel: [``, `pr-8`, `pr-14`],
    field: [``, `pr-7`, `pr-12`],
} as const;
const controls = computed(() => (clearable ? 1 : 0) + (matchCase.value === undefined ? 0 : 1));
const inputClass = computed(() =>
    twMerge(
        `field-bare w-full min-w-0 md:text-xs`,
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

// Esc clears without leaving the field; not stopped, so a second Esc still reaches whatever else claims it.
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
            <!--
                `mousedown` is suppressed so a press keeps the caret in the field rather than stealing it; click still
                fires for keyboard activation. Both controls sit inside the field, so `touch-target` grows the tap
                area, not the glyph.
            -->
            <button
                v-if="matchCase !== undefined"
                type="button"
                class="touch-target flex h-4 w-4 items-center justify-center rounded font-mono text-3xs leading-none text-subtle transition-colors hover:bg-overlay hover:text-content"
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
                class="touch-target flex items-center rounded text-2xs text-subtle transition-colors hover:text-content"
                v-tooltip.bottom="'Clear (Esc)'"
                aria-label="Clear filter"
                @click="clear"
            >
                <Icon name="times" />
            </button>
        </div>
    </div>
</template>
