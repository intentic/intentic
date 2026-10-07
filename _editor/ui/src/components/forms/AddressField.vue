<!-- One address on one line: the browser's address bar, and every place that shows a single URL to read, copy or open.
     Editable and read-only are the same box, so an address looks the same whether it can be changed there or not. -->
<script setup lang="ts">
import CopyButton from "../primitives/CopyButton.vue";
import { computed, nextTick, ref } from "vue";
import { useT } from "../../i18n/index.js";
import { ui } from "../../lib/ui.js";

const {
    value,
    editable = false,
    placeholder = ``,
    copyLabel,
    openLabel,
    openable = false,
} = defineProps<{
    // The address shown, and what copy and open act on. Editing never changes it; the caller does, after `submit`.
    value: string;
    // A field to type into: Enter emits `submit` with the text, Escape puts `value` back.
    editable?: boolean;
    placeholder?: string;
    // Accessible names for the copy and open presses, when the generic "Copy" / "Open" say too little.
    copyLabel?: string;
    openLabel?: string;
    // An open-in-new-tab press beside copy, for an address that is a page to visit.
    openable?: boolean;
}>();

// `cancel` is Escape: the caller may want the focus somewhere of its own.
const emit = defineEmits<{ submit: [text: string]; cancel: [] }>();

const t = useT();
const input = ref<HTMLInputElement | undefined>();
// What the owner has typed since focusing; undefined shows `value`.
const draft = ref<string>();
const shown = computed(() => draft.value ?? value);

// The padlock reads off the real address, never the draft: typing changes nothing until Enter.
const secure = computed((): boolean | undefined => {
    try {
        const url = new URL(value);
        if (url.host === ``) {
            return undefined;
        }
        return url.protocol === `https:` || url.protocol === `wss:` ? true : url.protocol === `http:` || url.protocol === `ws:` ? false : undefined;
    } catch {
        // allow(silent-catch): not a URL (empty, about:blank, a bare path) carries no padlock.
        return undefined;
    }
});

// Focusing selects the whole address, so a click then Ctrl+C copies it, and typing replaces it.
const focus = (): void => {
    if (editable) {
        draft.value = shown.value;
    }
    input.value?.focus();
    void nextTick(() => input.value?.select());
};

const submit = (): void => {
    const text = draft.value ?? value;
    draft.value = undefined;
    input.value?.blur();
    emit(`submit`, text);
};

const revert = (): void => {
    draft.value = undefined;
    input.value?.blur();
    emit(`cancel`);
};

defineExpose({ focus });
</script>

<template>
    <!-- The shell draws the frame and takes the focus; the field inside is bare, as the design system's inline fields are. -->
    <div class="ui-field-shell group flex min-w-0 items-center gap-1 py-px pl-2 pr-0.5">
        <Icon
            v-if="secure !== undefined"
            :name="secure ? 'lock' : 'unlock'"
            class="shrink-0 text-3xs"
            :class="secure ? 'text-subtle' : 'text-warning'"
        />
        <input
            ref="input"
            :value="shown"
            type="text"
            spellcheck="false"
            autocomplete="off"
            :readonly="!editable"
            :placeholder="placeholder"
            :aria-label="placeholder || undefined"
            class="field-bare min-w-0 flex-1 truncate font-mono md:text-xs"
            :class="editable ? '' : 'text-muted focus:text-content'"
            @focus="focus"
            @input="draft = ($event.target as HTMLInputElement).value"
            @keydown.enter.prevent="editable && submit()"
            @keydown.esc.prevent="revert"
            @blur="draft = undefined"
        />
        <!-- In a bar meant for typing, copy stays out of the way until the pointer comes; where reading is the point it
             is always there. -->
        <CopyButton
            v-if="value"
            :text="value"
            class="shrink-0"
            :class="editable ? 'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100' : ''"
            :aria-label="copyLabel ?? t(`ui.action.copy`)"
            v-tooltip.bottom="copyLabel ?? t(`ui.action.copy`)"
        />
        <a
            v-if="openable && value"
            :href="value"
            target="_blank"
            rel="noopener"
            :class="ui.iconButton(`shrink-0 text-subtle`)"
            :aria-label="openLabel ?? t(`ui.action.newTab`)"
            v-tooltip.bottom="openLabel ?? t(`ui.action.newTab`)"
        >
            <Icon name="external-link" class="text-2xs" />
        </a>
    </div>
</template>
