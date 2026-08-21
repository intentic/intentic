<!-- THE CONTROLS ON ONE SANDBOX'S ROW, drawn once for both apps.
     The desktop app's manager window and the web's Computers tab do the same job to the same containers, and
     they had drifted into two different sets: the window had a log tail and no Restart, the tab had a Restart and
     no log tail, and neither offered the rollback both of their backends could already do. Which verbs exist,
     what they are called, what order they sit in and which of them is red is one decision, so it is made here
     rather than twice: the callers keep only what differs, which is how the click reaches the machine.
     Their sentences and order live in sandboxVerbs.ts.

     ONE BUTTON AND A MENU, which is the redesign. All six verbs used to sit on the row as equal text buttons: on
     a machine running four sandboxes that is twenty-four controls on one screen in one weight, and the row's own
     NAME (the thing anybody scans for) was the quietest object on the line it titled. The power verb stays,
     because it is what the row's own dot is about and what people reach for; everything else is one deliberate
     click away, with removal alone under a divider rather than sitting a few pixels from Roll back.

     The MENU is this component's own, not the caller's. A caller holding one shared menu would have to track
     which row opened it and rebuild the model per row: the state every list that hand-rolls an overflow gets
     wrong, and the menu's overlay only mounts while it is open, so a row that is never pressed costs nothing.

     The event is unchanged (`act`), so neither app knows any of this happened. -->
<script setup lang="ts">
import type { MenuItem } from "primevue/menuitem";
import Button from "primevue/button";
import { computed, ref } from "vue";
import type { IconName } from "../icons/iconSets.js";
import ContextMenu from "./ContextMenu.vue";
import Icon from "./Icon.vue";
import { DESTRUCTIVE_VERB, menuVerbs, primaryVerb, type SandboxVerb, VERB_LABEL } from "./sandboxVerbs.js";

const {
    running,
    busy,
    disabled = false,
    logsOpen = false,
} = defineProps<{
    /** The container's own state: it decides whether the row's button says Start or Stop. */
    running: boolean;
    /** The verb running on THIS row right now, which is the one that spins. */
    busy?: SandboxVerb | undefined;
    /** Something is running somewhere: every verb on every row waits, because they all drive one machine. */
    disabled?: boolean | undefined;
    /** Whether this row's log pane is showing, which is the only thing the toggle's label depends on. */
    logsOpen?: boolean | undefined;
}>();

const emit = defineEmits<{ act: [verb: SandboxVerb] }>();

// A glyph per row, because a menu of five bare words is read line by line and a menu with a gutter is read by
// shape. They are the app's own vocabulary for the same ideas elsewhere: history for a rollback, undo for the
// image before it, terminal for output.
const VERB_ICON: Record<SandboxVerb, IconName> = {
    start: `play`,
    stop: `stop`,
    restart: `refresh`,
    update: `download`,
    rollback: `undo`,
    logs: `terminal`,
    remove: `trash`,
};

const power = computed(() => primaryVerb(running));
const labelOf = (verb: SandboxVerb): string => (verb === `logs` ? (logsOpen ? `Hide logs` : `Logs`) : VERB_LABEL[verb]);

/* WHAT THE ⋯ BUTTON SHOWS WHILE SOMETHING IS RUNNING. A verb that lives in the menu has no button of its own to
 * spin, so the control that opened it takes the spinner: otherwise an update, which takes minutes, reads as a
 * click that did nothing at all. */
const menuBusy = computed(() => busy !== undefined && busy !== power.value);

const menu = ref<{ show: (event: Event) => void } | undefined>();
const items = computed<MenuItem[]>(() => [
    ...menuVerbs(running).map((verb) => ({ label: labelOf(verb), icon: VERB_ICON[verb], command: () => emit(`act`, verb) })),
    { separator: true },
    // The caller still asks its own confirmation (sandboxVerbPrompt): this only makes the row stop presenting
    // "delete everything" as the seventh item in a row of harmless ones.
    { label: VERB_LABEL[DESTRUCTIVE_VERB], icon: VERB_ICON[DESTRUCTIVE_VERB], danger: true, command: () => emit(`act`, DESTRUCTIVE_VERB) },
]);
</script>

<template>
    <span class="flex shrink-0 items-center gap-0.5">
        <Button
            size="small"
            severity="secondary"
            :text="true"
            :label="VERB_LABEL[power]"
            :loading="busy === power"
            :disabled="disabled"
            @click="emit(`act`, power)"
        />
        <Button
            size="small"
            severity="secondary"
            :text="true"
            :loading="menuBusy"
            :disabled="disabled"
            aria-haspopup="menu"
            aria-label="More actions"
            v-tooltip.top="`More actions`"
            @click="menu?.show($event)"
        >
            <template #icon><Icon name="ellipsis" /></template>
        </Button>
        <ContextMenu ref="menu" :model="items" :min-width="11" />
    </span>
</template>
