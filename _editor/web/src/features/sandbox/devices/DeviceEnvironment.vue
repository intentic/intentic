<script setup lang="ts">
import { agentLines, Button, DeviceAgentNotes, Icon, Row, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import AgentRunStrip from "./health/AgentRunStrip.vue";
import DeviceConcern from "./health/DeviceConcern.vue";
import { cardRoute } from "./deviceLinks";
import type { DeviceAgentPanel } from "./deviceAgent";
import type { DeviceConcern as Concern } from "./health/deviceAttention";
import { type DeviceRow, deviceState, deviceTone } from "./deviceRows";
import { lastSeenNote, syncNote, syncStopped } from "./deviceFacts";
import { environmentAddressed, environmentDetail, environmentIdentity, environmentTitle } from "./machineEnvironments";
import type { DeviceOps } from "./runners/deviceOps";

// ONE ENVIRONMENT, ONE SHAPE. A PC reached through one door and a PC reached through three are the same kind of
// thing, so they are the same row: this is the device page's masthead on a machine of one environment, and each
// line of its Environments list on a machine of several. The page used to draw those two cases differently — a
// whole <DeviceAgentGroup> section for a lone device's version string, an inlined version of it per row otherwise
// — and the two had drifted.
//
// The row states each fact once. The badge owns the state word, the name owns the identity, the meta cluster owns
// the agent's build, and everything that is an ERRAND hangs below on the row's own spine, so a sentence about this
// environment can never be read as a sentence about the machine.

const { environment, panel, concerns, readAt, ops, masthead, hardware } = defineProps<{
    environment: DeviceRow;
    /** Undefined on an environment with no version from either door and no command door. */
    panel: DeviceAgentPanel | undefined;
    concerns: readonly Concern[];
    /** When this reading landed; the environment is judged as of then, not as of now (see deviceFacts.ts). */
    readAt: number;
    /** The page's own ops, so an answer lands under the row it was pressed on. */
    ops: DeviceOps;
    /** The lone machine's row IS the page's masthead: one step up in size, outside any group. */
    masthead?: boolean;
    // What the machine is, for the masthead alone: on a many-sided machine this line belongs to the PC, not to
    // any one of its environments, and the page's own masthead carries it.
    hardware?: string;
}>();

const emit = defineEmits<{ connect: [] }>();

const device = computed(() => environment.device);

// The door id, unless the masthead has already said it: a lone machine is usually addressed by its own name, and
// printing `ada-air` under the title `ada-air` is the repetition this page was rebuilt to stop. A list row's title
// is the OS, so its door id is never the thing above it.
const identity = computed(() => {
    const door = environmentIdentity(environment);
    return masthead === true && door === device.value.label ? undefined : door;
});

// Only when it has stopped. A working enrollment used to say "syncing files and ports" on every visit; the folder
// and the mirrored ports in the Sandboxes section are that same fact, in the machine's own numbers.
const stoppedSync = computed(() => (syncStopped(device.value, readAt) ? syncNote(device.value, readAt) : undefined));

const notes = computed(() => (panel === undefined ? [] : agentLines(panel)));

// The last press on this environment's agent, as one strip with a state (agentRun.ts). Drawn IN PLACE of the concern
// that offered it when there is one, since that concern is now a question already answered: its count is the reading
// from before the press, and leaving its button live beside the run is what made a finished drop look unfinished.
const run = computed(() => ops.agentRun(environment));
const answers = (concern: Concern): boolean => run.value !== undefined && concern.fix?.kind === `agent` && concern.fix.op === run.value.op;
// A run whose concern is gone (the fresh reading no longer raises it) or that no concern offered (a standing button)
// still has to be drawn somewhere: after the concerns, on the same spine.
const standalone = computed(() => run.value !== undefined && !concerns.some(answers));

const below = computed(() => stoppedSync.value !== undefined || concerns.length > 0 || notes.value.length > 0 || run.value !== undefined);
</script>

<template>
    <Row
        :icon="masthead ? undefined : `desktop`"
        :flush="masthead"
        :heading="masthead ? 2 : undefined"
        :density="masthead ? `comfortable` : undefined"
        :spine="!masthead"
        :title="masthead ? undefined : environmentTitle(environment)"
    >
        <!-- The masthead's mark is a plaque rather than a bare glyph: it outranks every row under it. -->
        <template v-if="masthead" #lead="{ mark }">
            <span
                class="flex shrink-0 items-center justify-center rounded-md bg-content/10 text-content"
                :style="{ width: `${mark}px`, height: `${mark}px` }"
            >
                <Icon name="desktop" class="text-sm" />
            </span>
        </template>

        <!-- The masthead names the MACHINE and carries its OS beside it; a list row is the environment itself. -->
        <template v-if="masthead" #title>
            <span class="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span class="min-w-0 truncate">{{ device.label }}</span>
                <span class="shrink-0 truncate text-sm font-normal text-muted">{{ environmentTitle(environment) }}</span>
            </span>
        </template>

        <!-- The door id every tool and skill on this environment is named after, and nothing else: shell, home and
             the doors this sandbox holds are on hover, since none of them is why anybody opened this page. -->
        <!-- The hover rides the whole line, not the door id: a masthead that drops the id (because the name above
             already is it) must still be able to answer what shell this machine takes. -->
        <template v-if="identity || hardware" #description>
            <span v-tooltip.top="environmentDetail(environment)" class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span v-if="identity" :class="environmentAddressed(environment) ? `font-mono` : ``">{{ identity }}</span>
                <span v-if="hardware" class="text-subtle">{{ hardware }}</span>
            </span>
        </template>

        <template #meta>
            <!-- Noise on a live machine, the most useful fact on one that isn't. -->
            <span v-if="lastSeenNote(device)" class="shrink-0">{{ lastSeenNote(device) }}</span>
            <span v-if="panel?.version" class="shrink-0 font-mono">{{ panel.version }}</span>
            <StatusBadge :variant="deviceTone(device, readAt)" size="xs" :dot="true" :label="deviceState(device, readAt)" class="shrink-0" />
        </template>

        <!-- The agent's verbs through this environment's door: Restart for its own process, and Update only where this
             row is the whole machine, since an update moves every side and a many-sided page draws it once. -->
        <template v-if="(panel?.actions.length ?? 0) > 0" #control>
            <Button
                v-for="action in panel?.actions"
                :key="action.op"
                size="small"
                severity="secondary"
                :label="action.label"
                :loading="ops.agentOp(environment) === action.op"
                :disabled="ops.working.value"
                v-tooltip.top="action.hint"
                @click="void ops.runAgent(environment, action.op)"
            />
        </template>

        <!-- Everything this environment WANTS, on a spine under its own mark so it reads as this row's, not the
             machine's. Absent entirely on a healthy one, which is nearly all of them. -->
        <template v-if="below" #below>
            <div class="flex min-w-0 flex-col gap-2">
                <p v-if="stoppedSync" class="min-w-0 text-xs text-warning">{{ stoppedSync }}</p>
                <template v-for="concern in concerns" :key="concern.key">
                    <AgentRunStrip v-if="run && answers(concern)" :run="run" :machine="device.label" @dismiss="ops.dismissAgent(environment)" />
                    <DeviceConcern
                        v-else
                        :concern="concern"
                        :route="concern.fix?.kind === `card` ? cardRoute(concern.fix) : undefined"
                        :busy="ops.working.value"
                        :running="concern.fix?.kind === `agent` && ops.agentOp(environment) === concern.fix.op"
                        @connect="emit(`connect`)"
                        @agent="(op) => void ops.runAgent(environment, op)"
                    />
                </template>
                <DeviceAgentNotes :notes="notes" />
                <AgentRunStrip v-if="run && standalone" :run="run" :machine="device.label" @dismiss="ops.dismissAgent(environment)" />
            </div>
        </template>
    </Row>
</template>
