<!-- The browser's address bar and its search box in one: it shows where the page is and takes whatever is typed into
     it (address.ts decides whether that is an address or a search). Drawn the way a browser draws its own rather than
     as the kit's AddressField: while nobody is typing, the scheme folds into the padlock and the host stands out from
     the path; the moment somebody clicks, the whole address comes back, selected, ready to be typed over. -->
<script setup lang="ts">
import { CopyButton, Icon } from "@intentic/ui";
import { computed, nextTick, ref } from "vue";
import { addressParts, securityOf } from "./address";

const {
    value,
    editable = false,
    placeholder = ``,
    copyLabel,
    secureLabel,
    insecureLabel,
} = defineProps<{
    // The page's own address; empty for a blank page. Typing never changes it, the caller does after `submit`.
    value: string;
    // False for a closed browser's record: the address can still be read and copied, not sent anywhere.
    editable?: boolean;
    placeholder?: string;
    copyLabel?: string;
    // What the padlock says on hover: the page is private, or it travels in the clear.
    secureLabel?: string;
    insecureLabel?: string;
}>();

// `cancel` is Escape: the caller puts the keyboard back on the page.
const emit = defineEmits<{ submit: [text: string]; cancel: [] }>();

const input = ref<HTMLInputElement | undefined>();
// What has been typed since focusing; undefined shows the page's address.
const draft = ref<string>();
const focused = ref(false);
const shown = computed(() => draft.value ?? value);

// Off the real address, never the draft: typing changes nothing until Enter.
const security = computed(() => securityOf(value));
const parts = computed(() => addressParts(value));
// The drawn address stands over the input only while it is at rest; typing happens in the input itself.
const dressed = computed(() => !focused.value && parts.value !== undefined);

// The glyph at the front says what Enter will do: a search while typing or on a blank page, otherwise how private the
// page is.
const glyph = computed(() =>
    focused.value || value === `` ? `search` : security.value === `secure` ? `lock` : security.value === `insecure` ? `unlock` : `globe`,
);

// Focusing selects the whole address, so a click then Ctrl+C copies it, and typing replaces it.
const onFocus = (): void => {
    focused.value = true;
    if (editable) {
        draft.value = shown.value;
    }
    void nextTick(() => input.value?.select());
};

const focus = (): void => input.value?.focus();

const submit = (): void => {
    if (!editable) {
        return;
    }
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

const onBlur = (): void => {
    focused.value = false;
    draft.value = undefined;
};

defineExpose({ focus });
</script>

<template>
    <!-- The shell draws the frame and takes the focus; the field inside is bare. -->
    <div class="ui-field-shell group relative flex h-8 min-w-0 items-center gap-2 rounded-full pl-3 pr-1" @mousedown.self.prevent="focus">
        <Icon
            :name="glyph"
            class="shrink-0 text-2xs"
            :class="glyph === 'unlock' ? 'text-warning' : 'text-subtle'"
            v-tooltip.bottom="glyph === 'lock' ? secureLabel : glyph === 'unlock' ? insecureLabel : undefined"
        />
        <div class="relative flex min-w-0 flex-1 items-center">
            <input
                ref="input"
                :value="shown"
                type="text"
                spellcheck="false"
                autocomplete="off"
                autocapitalize="off"
                enterkeyhint="go"
                :readonly="!editable"
                :placeholder="placeholder"
                :aria-label="placeholder || undefined"
                class="field-bare min-w-0 flex-1 truncate md:text-xs"
                :class="dressed ? 'text-transparent' : editable ? '' : 'text-muted'"
                @focus="onFocus"
                @blur="onBlur"
                @input="draft = ($event.target as HTMLInputElement).value"
                @keydown.enter.prevent="submit"
                @keydown.esc.prevent="revert"
            />
            <!-- The address at rest, laid exactly over the input's own text so a click lands in the input underneath. -->
            <span
                v-if="dressed && parts"
                aria-hidden="true"
                class="pointer-events-none absolute inset-0 flex items-center truncate whitespace-pre text-base md:text-xs"
            >
                <span class="truncate">
                    <span :class="editable ? 'text-content' : 'text-muted'">{{ parts.host }}</span>
                    <span class="text-subtle">{{ parts.rest }}</span>
                </span>
            </span>
        </div>
        <!-- Out of the way until the pointer comes: this bar is for typing, copying is the second thing. -->
        <CopyButton
            v-if="value"
            :text="value"
            class="shrink-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            :aria-label="copyLabel"
            v-tooltip.bottom="copyLabel"
        />
    </div>
</template>
