<!-- A CONTROL THAT IS ALSO AN ADDRESS.
     Most navigational things in this app are plainly one or the other: a rail tile is a <RouterLink>, a Kill
     Terminal row is a <button>. This is for the third kind — the control whose ordinary click does something
     THIS window can do better than a page load can (point the docked chat at an agent, focus a panel, open a
     conversation in the column beside you) but which still names a place with a URL behind it.

     Those were written as <button>s, because the app-side behaviour is what a click has to run. The cost is
     everything a link is: no address under the pointer, nothing in the browser's own right-click menu, nothing
     to copy, and Ctrl/⌘-click doing whatever the button did instead of opening a tab.

     So: a real anchor with the real href, and the split is one rule. A plain click belongs to the app — the
     anchor stands down (`preventDefault`) and `activate` fires. A modified click belongs to the BROWSER — the
     app stands down, nothing here runs, and the tab opens exactly as the user asked. Middle-click never
     reaches this handler at all, which is the same answer arrived at for free.

     `custom` on the RouterLink is what makes that possible: the default link would run its own navigation
     alongside ours, and we need the href without the behaviour. -->
<script setup lang="ts">
import { browserOwnsClick } from "@intentic/ui";
import { type RouteLocationRaw, RouterLink } from "vue-router";

defineProps<{
    /** Where this control goes — the address a modified click opens, and the one the status bar shows. */
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
