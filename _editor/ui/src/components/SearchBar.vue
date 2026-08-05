<!-- The borderless search bar that sits at the top of a scrolling panel — the model picker's, the design
     system's own PickerPanel's. Not a form input: it has no border and no label, because it is the panel's
     first row rather than a field in a form (`cmp.input` is the bordered one, for forms).

     It exists for one line of hard-won CSS: `text-base` below `md`. 16px is the threshold under which iOS
     Safari zooms the page when an input takes focus, and a panel that zooms the whole app the moment someone
     taps its filter is a bug you only ever see on a real phone. Both copies of this bar carried that rule and
     a comment explaining it — which is exactly the sort of knowledge a third copy is written without.

     Keyboard handling stays with the CALLER: the keys mean different things to different panels (Escape clears
     the query in one and closes the panel in another), and they bubble from the input to this component's root,
     so a `@keydown` on the tag reaches them all. `focus()` is exposed because a desktop panel claims the
     keyboard as it opens, while a mobile sheet deliberately does not — that is the host's call, not this one's. -->
<script setup lang="ts">
import { ref } from "vue";
import Icon from "./Icon.vue";

const { placeholder = `Filter…` } = defineProps<{
    placeholder?: string;
    /** The listbox this bar drives, for assistive tech — the row highlight lives there, not here. */
    ariaControls?: string;
    ariaActivedescendant?: string;
}>();

const query = defineModel<string>({ required: true });

const input = ref<HTMLInputElement | null>(null);
defineExpose({ focus: (): void => input.value?.focus() });
</script>

<template>
    <div class="relative border-b border-line">
        <Icon name="search" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-subtle" aria-hidden="true" />
        <input
            ref="input"
            v-model="query"
            type="text"
            :placeholder="placeholder"
            class="w-full min-w-0 bg-transparent py-2 pl-9 pr-3 text-base text-content placeholder:text-subtle focus:outline-none md:text-xs"
            role="searchbox"
            :aria-controls="ariaControls"
            :aria-activedescendant="ariaActivedescendant"
        />
    </div>
</template>
