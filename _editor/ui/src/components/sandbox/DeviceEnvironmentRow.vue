<!-- One environment of a machine, as both Devices pages draw it: the masthead of a one-environment machine's page, and a
     row of a many-sided machine's Environments list. -->
<script setup lang="ts" generic="Op extends string">
import type { MenuItem } from "primevue/menuitem";
import { computed, ref, type VNode } from "vue";
import BrandMark from "../brand/BrandMark.vue";
import StatusBadge from "../feedback/StatusBadge.vue";
import type { StatusVariant } from "../feedback/statusBadge.js";
import Button from "../primitives/Button.vue";
import Icon from "../primitives/Icon.vue";
import ContextMenu from "../overlays/ContextMenu.vue";
import Row from "../rows/Row.vue";
import { useT } from "../../i18n/index.js";
import type { TooltipValue } from "../../lib/tooltip.js";
import type { AgentAction } from "./deviceAgent.js";
import type { OsMark } from "./deviceMachine.js";
import type { SandboxMenuVerb } from "./sandboxVerbs.js";

// ONE ENVIRONMENT, ONE SHAPE, ONE COMPONENT. A PC reached through one door and a PC reached through three are the same
// kind of thing, so they are the same row; and the computer the desktop app runs on is the same kind of thing as any
// computer a sandbox reaches, so its page opens on this same masthead. Until 2026-10-20 the desktop app drew its own
// header and a separate "Agent on this computer" group, and the two pages had drifted (no mark, a pid nobody asked
// for, a description of what the page is for where the machine's name belongs).
//
// The row states each fact once. The badge owns the state word, the name owns the identity, the meta cluster owns the
// agent's build, and everything that is an ERRAND hangs below on the row's own spine (`#below`), so a sentence about
// this environment can never be read as one about the machine. Pure presentation: each page brings its own facts and
// its own errands, and runs the agent verbs it is asked for (`run`).

const {
    name,
    kind,
    mark,
    idle = false,
    masthead = false,
    identity,
    identityMono = false,
    hardware,
    detail,
    seen,
    version,
    state,
    actions = [],
    running,
    busy = false,
    working,
    quiet = false,
    menu = [],
} = defineProps<{
    /** The machine's name: the masthead's title. */
    name: string;
    /** What this environment is, by its OS ("Windows 11 Home", "WSL · Arch Linux"): beside the masthead's name, a list row's title. */
    kind: string | undefined;
    mark: OsMark;
    /** Present but not answering (asleep, offline): the mark goes quiet. */
    idle?: boolean | undefined;
    /** The lone machine's row IS the page's masthead: one step up in size, outside any group. */
    masthead?: boolean | undefined;
    /** The id tools on this environment are named after, when the title above has not already said it. */
    identity?: string | undefined;
    /** Whether `identity` is an address (set in mono) rather than a name. */
    identityMono?: boolean | undefined;
    // What the machine is (its hardware, its engine's size), for the masthead alone: on a many-sided machine the line
    // belongs to the PC, and the page's own masthead carries it.
    hardware?: string | undefined;
    /** What the description line leaves out, on its hover (the shell, the home, the doors). */
    detail?: TooltipValue | undefined;
    /** When the machine was last heard from: noise on a live one, the most useful fact on one that isn't. */
    seen?: string | undefined;
    /** The build the agent serves. */
    version?: string | undefined;
    /** The environment's state, in the badge's word and colour. */
    state?: { readonly word: string; readonly variant: StatusVariant } | undefined;
    /** The agent's verbs through this environment's door, as buttons at the end of the row. */
    actions?: readonly AgentAction<Op>[] | undefined;
    /** The verb spinning right now, when one is. */
    running?: Op | undefined;
    /** True while any op on the page holds its one-at-a-time lock, whichever control started it. */
    busy?: boolean | undefined;
    // Work in flight on this environment's agent ("Updating… · 12s"), said ONCE, here, with the row's only spinner. It
    // stands in for the state badge, the last-seen and the verbs: a machine mid-update drops its socket by design, so
    // "reconnecting", "last seen now" and a dead Restart button beside a spinner were three tellings of one wait.
    working?: string | undefined;
    // A settled machine's masthead, said in fewer words: the agent's build goes to its badge's hover, since a version
    // beside a healthy state is a number nobody reads. The caller decides when the machine is settled.
    quiet?: boolean | undefined;
    /** The verbs a reader seldom needs (the agent's restart on a healthy machine, a move of its engine), behind one ⋯. */
    menu?: readonly SandboxMenuVerb[] | undefined;
}>();

const slots = defineSlots<{
    /** What this environment wants, and the answer to the last press on its agent. Absent on a healthy one. */
    below?: () => VNode[];
    /** A control after the verbs (the run's Output toggle), drawn while they are not. */
    aside?: () => VNode[];
}>();

const emit = defineEmits<{ run: [op: Op] }>();

const t = useT();
const badgeTip = computed(() => (quiet && version !== undefined ? t(`ui.deviceAgent.agentBuild`, { version }) : undefined));
const menuRef = ref<{ show: (event: Event) => void } | undefined>();
// The menu's rows as SandboxVerbs builds a card's: a hint and the danger ink only where the verb has them.
const menuRow = (verb: SandboxMenuVerb): MenuItem => {
    const row: MenuItem = { label: verb.label, icon: verb.icon, command: verb.run };
    if (verb.danger === true) {
        row[`danger`] = true;
    }
    if (verb.hint !== undefined) {
        row[`hint`] = verb.hint;
    }
    return row;
};
const menuItems = computed(() => menu.map(menuRow));
</script>

<template>
    <Row
        :flush="masthead"
        :heading="masthead ? 2 : undefined"
        :density="masthead ? `comfortable` : undefined"
        :spine="!masthead"
        :title="masthead ? undefined : kind"
    >
        <!-- The masthead's mark is a plaque rather than a bare glyph: it outranks every row under it. A list row's is the
             glyph alone, in the OS's own colour, so the sides of one PC are told apart before their names are read. -->
        <template #lead="{ mark: size }">
            <BrandMark :size="size" :name="name" :icon="mark.icon" :tint="mark.tint" :plain="!masthead" :idle="idle" />
        </template>

        <!-- The masthead names the MACHINE and carries its OS beside it; a list row is the environment itself. -->
        <template v-if="masthead" #title>
            <span class="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span class="min-w-0 truncate">{{ name }}</span>
                <span v-if="kind" class="shrink-0 truncate text-sm font-normal text-muted">{{ kind }}</span>
            </span>
        </template>

        <!-- The hover rides the whole line, not the door id: a masthead that drops the id (because the name above already
             is it) must still be able to answer what shell this machine takes. -->
        <template v-if="identity || hardware" #description>
            <span v-tooltip.top="detail" class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span v-if="identity" :class="identityMono ? `font-mono` : ``">{{ identity }}</span>
                <span v-if="hardware" class="text-subtle">{{ hardware }}</span>
            </span>
        </template>

        <template #meta>
            <span v-if="seen && !working" class="shrink-0">{{ seen }}</span>
            <span v-if="version && !quiet" class="shrink-0 font-mono">{{ version }}</span>
            <span v-if="working" class="inline-flex shrink-0 items-center gap-1.5 text-content tabular-nums" role="status">
                <Icon name="spinner" spin class="text-2xs text-info" aria-hidden="true" />{{ working }}
            </span>
            <StatusBadge v-else-if="state" v-tooltip.top="badgeTip" :variant="state.variant" size="xs" :dot="true" :label="state.word" class="shrink-0" />
        </template>

        <!-- The agent's verbs through this environment's door. Each runs on that machine, so each spins the whole
             page's lock rather than its own. -->
        <template v-if="((actions.length > 0 || menu.length > 0) && !working) || slots.aside" #control>
            <slot name="aside" />
            <template v-if="!working">
                <Button
                    v-for="action in actions"
                    :key="action.op"
                    size="small"
                    tier="quiet"
                    :label="action.label"
                    :loading="running === action.op"
                    :disabled="busy || running !== undefined"
                    v-tooltip.top="action.hint"
                    @click="emit(`run`, action.op)"
                />
                <template v-if="menu.length > 0">
                    <Button
                        size="small"
                        tier="quiet"
                        :loading="running !== undefined"
                        :disabled="busy || running !== undefined"
                        aria-haspopup="menu"
                        :aria-label="t(`ui.action.moreActions`)"
                        v-tooltip.top="t(`ui.action.moreActions`)"
                        @click="menuRef?.show($event)"
                    >
                        <template #icon><Icon name="ellipsis" /></template>
                    </Button>
                    <ContextMenu ref="menuRef" :model="menuItems" :min-width="11" />
                </template>
            </template>
        </template>

        <template v-if="slots.below" #below>
            <div class="flex min-w-0 flex-col gap-2"><slot name="below" /></div>
        </template>
    </Row>
</template>
