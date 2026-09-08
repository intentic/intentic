<!--
    Row controls for one sandbox: the power verb plus an overflow menu for the rest, shared by the web and desktop apps. Verb labels and order live
    in sandboxVerbs.ts; the menu is local, per-row state. Emits `act` only.
-->
<script setup lang="ts">
import type { MenuItem } from "primevue/menuitem";
import Button from "../primitives/Button.vue";
import { computed, ref } from "vue";
import type { IconName } from "../../icons/iconSets.js";
import ContextMenu from "../overlays/ContextMenu.vue";
import Icon from "../primitives/Icon.vue";
import { DESTRUCTIVE_VERB, menuVerbs, primaryVerb, type SandboxVerb, VERB_LABEL } from "./sandboxVerbs.js";

const {
    running,
    busy,
    disabled = false,
    logsOpen = false,
} = defineProps<{
    /** The container's own state: it decides whether the row's button says Start or Stop. */
    running: boolean;
    /** The verb running on this row right now, which is the one that spins. */
    busy?: SandboxVerb | undefined;
    /** Something is running somewhere: every verb on every row waits, since they all drive one machine. */
    disabled?: boolean | undefined;
    /** Whether this row's log pane is showing, the only thing the toggle's label depends on. */
    logsOpen?: boolean | undefined;
}>();

const emit = defineEmits<{ act: [verb: SandboxVerb] }>();

// A glyph per row, so the menu is read by shape rather than word-by-word; each icon matches the app's
// vocabulary for the same idea elsewhere.
const VERB_ICON: Record<SandboxVerb, IconName> = {
    start: `play`,
    stop: `stop`,
    restart: `refresh`,
    update: `download`,
    rollback: `undo`,
    resources: `sliders-h`,
    logs: `terminal`,
    remove: `trash`,
};

const power = computed(() => primaryVerb(running));
const labelOf = (verb: SandboxVerb): string => (verb === `logs` ? (logsOpen ? `Hide logs` : `Logs`) : VERB_LABEL[verb]);

// What the ⋯ button shows while something runs: a menu verb has no button of its own to spin, so the
// control that opened it takes the spinner.
const menuBusy = computed(() => busy !== undefined && busy !== power.value);

const menu = ref<{ show: (event: Event) => void } | undefined>();
const items = computed<MenuItem[]>(() => [
    ...menuVerbs(running).map((verb) => ({ label: labelOf(verb), icon: VERB_ICON[verb], command: () => emit(`act`, verb) })),
    { separator: true },
    // The caller still asks its own confirmation; this only stops the row presenting removal as the seventh
    // item beside harmless ones.
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
