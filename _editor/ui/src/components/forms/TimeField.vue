<!-- A time of day, typed the way people say it ("9", "930", "9:30pm") or pressed in the list that drops under it: the app's own, never the browser's spinner of hour and minute columns. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useDevice } from "../../composables/useDevice.js";
import { clockSlots, clockText, parseClock, stepClock } from "../../lib/clock.js";
import { ui } from "../../lib/ui.js";
import AnchoredOverlay from "../overlays/AnchoredOverlay.vue";
import Icon from "../primitives/Icon.vue";

const {
    step = 30,
    placeholder = `09:00`,
    ariaLabel,
    invalid = false,
    disabled = false,
} = defineProps<{
    /** Minutes between the times the list offers; any minute can still be typed. */
    step?: number;
    placeholder?: string;
    ariaLabel?: string;
    /** The caller's verdict on the time (say, already past): drawn as the field's error rim. */
    invalid?: boolean;
    disabled?: boolean;
}>();

/** "HH:MM" on the 24-hour clock, or blank for none yet. */
const time = defineModel<string>({ required: true });

// What the box holds as typed: read on every keystroke, tidied to "09:30" once the reader moves on. Follows a time set
// from outside unless it already says the same thing.
const typed = ref(time.value);
watch(time, (next) => {
    if (parseClock(typed.value) !== parseClock(next)) {
        typed.value = next;
    }
});
const minutes = computed(() => parseClock(typed.value));
const unreadable = computed(() => typed.value.trim() !== `` && minutes.value === undefined);
const write = (text: string): void => {
    typed.value = text;
    const parsed = parseClock(text);
    if (parsed !== undefined) {
        time.value = clockText(parsed);
    } else if (text.trim() === ``) {
        time.value = ``;
    }
};
const tidy = (): void => {
    if (minutes.value !== undefined) {
        typed.value = clockText(minutes.value);
    }
};

/* ---- the list under it: a pointer's way to a time, never on a phone, whose keyboard already covers the screen ---- */

const { mobile } = useDevice();
const anchor = ref<HTMLElement>();
const list = ref<HTMLElement>();
const open = ref(false);
const slots = computed(() => clockSlots(step));
// The row the list stands on: the time picked, else the nearest one before it, so the list opens where the reader is.
const current = computed(() => {
    const at = minutes.value;
    return at === undefined ? undefined : Math.floor(at / step) * step;
});
const reveal = async (): Promise<void> => {
    await nextTick();
    const row = list.value?.querySelector<HTMLElement>(`[data-minutes="${current.value ?? 9 * 60}"]`);
    row?.scrollIntoView({ block: `center` });
};
const show = (): void => {
    if (mobile.value || disabled || open.value) {
        return;
    }
    open.value = true;
    void reveal();
};
const choose = (slot: number): void => {
    write(clockText(slot));
    open.value = false;
};

const field = ref<HTMLInputElement>();
// Focusing selects what it holds, so typing a time replaces the one there rather than running into it; after the press
// that focused it, which would otherwise put the caret back where it landed.
const onFocus = (): void => {
    requestAnimationFrame(() => field.value?.select());
    show();
};
const onBlur = (): void => {
    tidy();
    open.value = false;
};
const onInput = (event: Event): void => {
    // SAFETY: bound on the time box's own input event.
    write((event.target as HTMLInputElement).value);
};
const onKey = (event: KeyboardEvent): void => {
    if (event.key === `Enter`) {
        // A time is not a form's submit: Enter settles what was typed.
        event.preventDefault();
        tidy();
        open.value = false;
        return;
    }
    if (event.key === `ArrowUp` || event.key === `ArrowDown`) {
        event.preventDefault();
        write(clockText(stepClock(minutes.value ?? 9 * 60, event.key === `ArrowUp` ? 1 : -1)));
        void reveal();
    }
};
</script>

<template>
    <span ref="anchor" class="relative inline-flex items-center" @click="show">
        <Icon name="clock" class="pointer-events-none absolute left-2.5 text-2xs text-subtle" />
        <input
            ref="field"
            :value="typed"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            spellcheck="false"
            maxlength="8"
            role="combobox"
            :aria-expanded="open"
            aria-autocomplete="none"
            :placeholder="placeholder"
            :aria-label="ariaLabel"
            :aria-invalid="invalid || unreadable"
            :disabled="disabled"
            class="w-28 pl-7 tabular-nums"
            :class="[ui.input(), invalid || unreadable ? `ui-field-error-box` : ``]"
            @input="onInput"
            @focus="onFocus"
            @blur="onBlur"
            @keydown="onKey"
        />
    </span>
    <AnchoredOverlay v-model="open" :anchor="anchor" side="bottom" :gap="4" :restore-focus="false" menu>
        <!-- Rows take no focus and swallow the press's mousedown, so the caret stays in the box while one is picked. -->
        <div ref="list" role="listbox" :aria-label="ariaLabel" class="flex max-h-56 w-28 flex-col overflow-y-auto p-1">
            <button
                v-for="slot in slots"
                :key="slot"
                type="button"
                role="option"
                tabindex="-1"
                :data-minutes="slot"
                :aria-selected="slot === minutes"
                class="shrink-0 cursor-pointer rounded-md px-2.5 py-1 text-left text-sm tabular-nums transition-colors md:text-xs"
                :class="slot === minutes ? `bg-primary-fill font-semibold text-fill-content` : slot === current ? `bg-overlay text-content` : `text-content hover:bg-overlay`"
                @mousedown.prevent
                @click="choose(slot)"
            >
                {{ clockText(slot) }}
            </button>
        </div>
    </AnchoredOverlay>
</template>
