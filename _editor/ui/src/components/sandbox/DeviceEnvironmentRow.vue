<!-- One environment of a machine, as both Devices pages draw it: the masthead of a one-environment machine's page, and a
     row of a many-sided machine's Environments list. -->
<script setup lang="ts" generic="Op extends string">
import type { VNode } from "vue";
import BrandMark from "../brand/BrandMark.vue";
import StatusBadge from "../feedback/StatusBadge.vue";
import type { StatusVariant } from "../feedback/statusBadge.js";
import Button from "../primitives/Button.vue";
import Row from "../rows/Row.vue";
import type { TooltipValue } from "../../lib/tooltip.js";
import type { AgentAction } from "./deviceAgent.js";
import type { OsMark } from "./deviceMachine.js";

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
}>();

const slots = defineSlots<{
    /** What this environment wants, and the answer to the last press on its agent. Absent on a healthy one. */
    below?: () => VNode[];
}>();

const emit = defineEmits<{ run: [op: Op] }>();
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
            <span v-if="seen" class="shrink-0">{{ seen }}</span>
            <span v-if="version" class="shrink-0 font-mono">{{ version }}</span>
            <StatusBadge v-if="state" :variant="state.variant" size="xs" :dot="true" :label="state.word" class="shrink-0" />
        </template>

        <!-- The agent's verbs through this environment's door. Each runs on that machine, so each spins the whole
             page's lock rather than its own. -->
        <template v-if="actions.length > 0" #control>
            <Button
                v-for="action in actions"
                :key="action.op"
                size="small"
                tier="boring"
                :label="action.label"
                :loading="running === action.op"
                :disabled="busy || running !== undefined"
                v-tooltip.top="action.hint"
                @click="emit(`run`, action.op)"
            />
        </template>

        <template v-if="slots.below" #below>
            <div class="flex min-w-0 flex-col gap-2"><slot name="below" /></div>
        </template>
    </Row>
</template>
