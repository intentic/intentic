<!--
    Renders a real `<a href>` that also behaves like a button. A plain click calls `preventDefault` and emits `activate`; a modified or middle click
    is left to the browser untouched. Needs `custom` on the underlying RouterLink so it does not navigate on its own.
-->
<script setup lang="ts">
import { browserOwnsClick } from "@intentic/ui";
import { type RouteLocationRaw, RouterLink } from "vue-router";

defineProps<{
    /** Where this control goes: the address a modified click opens, and the one the status bar shows. */
    to: RouteLocationRaw;
}>();

const emit = defineEmits<{
    /** The plain click. Whatever this window does instead of a page load. */
    activate: [event: MouseEvent];
}>();

const onClick = (event: MouseEvent): void => {
    if (browserOwnsClick(event)) {
        return; // a tab is opening elsewhere; this one must not move underneath it
    }
    event.preventDefault();
    emit(`activate`, event);
};
</script>

<template>
    <RouterLink :to="to" custom v-slot="{ href }">
        <a :href="href" @click="onClick"><slot /></a>
    </RouterLink>
</template>
