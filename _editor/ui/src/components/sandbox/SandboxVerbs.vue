<!-- Row controls for one sandbox: the power verb plus an overflow menu for the rest, shared by the web and desktop apps.
     `compact` folds the power verb into the menu too, for a list that acts on its rows by selecting them: the row keeps
     one quiet ⋯ instead of a word per line. -->
<script setup lang="ts">
import type { MenuItem } from "primevue/menuitem";
import Button from "../primitives/Button.vue";
import { computed, ref } from "vue";
import type { IconName } from "../../icons/iconSets.js";
import ContextMenu from "../overlays/ContextMenu.vue";
import Icon from "../primitives/Icon.vue";
import { DESTRUCTIVE_VERB, menuVerbs, primaryVerb, type RollbackChoice, type SandboxVerb, VERB_LABEL } from "./sandboxVerbs.js";
import { useT } from "../../i18n/index.js";

const t = useT();

const {
    running,
    busy,
    disabled = false,
    logsOpen = false,
    compact = false,
    container = true,
    rollbackChoices = [],
} = defineProps<{
    /** The container's own state: it decides whether the row's button says Start or Stop. */
    running: boolean;
    /** Every verb behind the ⋯, the power verb first: for a list whose bulk verbs live in a bar above it. */
    compact?: boolean | undefined;
    // False for a row this machine holds only the files of: there is no container to power or reshape, so the menu is
    // the one act that applies to it.
    container?: boolean | undefined;
    /** The verb running on this row right now, which is the one that spins. */
    busy?: SandboxVerb | undefined;
    /** Something is running somewhere: every verb on every row waits, since they all drive one machine. */
    disabled?: boolean | undefined;
    /** Whether this row's log pane is showing, the only thing the toggle's label depends on. */
    logsOpen?: boolean | undefined;
    // The versions this machine kept, newest first, when it can go back to any of them: Roll back becomes one row per
    // version. Fewer than two is the plain verb, since there is nothing to choose between.
    rollbackChoices?: readonly RollbackChoice[] | undefined;
}>();

const emit = defineEmits<{ act: [verb: SandboxVerb]; rollbackTo: [choice: RollbackChoice] }>();

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
const menuBusy = computed(() => busy !== undefined && (compact || !container || busy !== power.value));
const item = (verb: SandboxVerb): MenuItem => ({ label: labelOf(verb), icon: VERB_ICON[verb], command: () => emit(`act`, verb) });

// Roll back as one row, or, with versions to choose between, one row per version this machine kept: the newest is the
// plain rollback and the rest name their target. Rows of this list rather than a submenu, which the menu's own
// scrolling box clips.
const rollbackRows = (): MenuItem[] =>
    rollbackChoices.length < 2
        ? [item(`rollback`)]
        : rollbackChoices.map((choice, at) => {
              const row: MenuItem = {
                  label: t(`ui.sandboxSandboxVerbs.rollBackTo`, { version: choice.version }),
                  icon: VERB_ICON.rollback,
                  command: () => (choice.to === undefined ? emit(`act`, `rollback`) : emit(`rollbackTo`, choice)),
              };
              if (at === 0) {
                  row[`hint`] = t(`ui.sandboxSandboxVerbs.versionBefore`);
              }
              return row;
          });

const menu = ref<{ show: (event: Event) => void } | undefined>();
const items = computed<MenuItem[]>(() => [
    ...(container
        ? [
              ...(compact ? [item(power.value)] : []),
              ...menuVerbs(running).flatMap((verb) => (verb === `rollback` ? rollbackRows() : [item(verb)])),
              { separator: true },
          ]
        : []),
    // The caller still asks its own confirmation; this only stops the row presenting removal as the seventh
    // item beside harmless ones.
    { label: VERB_LABEL[DESTRUCTIVE_VERB], icon: VERB_ICON[DESTRUCTIVE_VERB], danger: true, command: () => emit(`act`, DESTRUCTIVE_VERB) },
]);
</script>

<template>
    <span class="flex shrink-0 items-center gap-0.5">
        <Button
            v-if="!compact && container"
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
            :aria-label="t(`ui.action.moreActions`)"
            v-tooltip.top="t(`ui.action.moreActions`)"
            @click="menu?.show($event)"
        >
            <template #icon><Icon name="ellipsis" /></template>
        </Button>
        <ContextMenu ref="menu" :model="items" :min-width="11" />
    </span>
</template>
