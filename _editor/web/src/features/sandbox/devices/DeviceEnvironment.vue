<script setup lang="ts">
import { agentLines, Button, DeviceAgentNotes, DeviceEnvironmentRow, DeviceRunLog, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import AgentRunStrip from "./health/AgentRunStrip.vue";
import { useLineWithElapsed } from "../../../components/progress/useProgress";
import { agentRunLive, agentRunWorking } from "./runners/agentRun";
import DeviceConcern from "./health/DeviceConcern.vue";
import { cardRoute } from "../../../models/sandbox/devices/deviceLinks";
import type { DeviceAgentPanel } from "./deviceAgent";
import type { DeviceConcern as Concern } from "../../../models/sandbox/devices/deviceAttention";
import { type DeviceRow, deviceState, deviceTone } from "../../../models/sandbox/devices/deviceRows";
import { lastSeenNote, osMark, syncNote, syncStopped } from "../../../models/sandbox/devices/deviceFacts";
import { environmentAddressed, environmentDetail, environmentIdentity, environmentTitle } from "./machineEnvironments";
import type { DeviceOps } from "./runners/deviceOps";

// ONE ENVIRONMENT, ONE SHAPE. A PC reached through one door and a PC reached through three are the same kind of
// thing, so they are the same row: this is the device page's masthead on a machine of one environment, and each
// line of its Environments list on a machine of several. The row itself is the kit's (DeviceEnvironmentRow), which the
// desktop app's Devices view opens on as well; this is what a sandbox's registry knows about one environment, and the
// errands it raises, hung on the row's own spine so a sentence about this environment can never be read as a sentence
// about the machine.

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

const t = useT();

const device = computed(() => environment.device);
// The OS this environment runs, as its own mark: a Windows side and an Arch side of one PC used to share a monitor.
const os = computed(() => osMark(device.value));
const asleep = computed(() => deviceTone(device.value, readAt) === `neutral`);

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

// The last press on this environment's agent (agentRun.ts). WHILE IT RUNS it is said once, on the row itself: one
// spinner and how long it has gone ("Updating… · 12s"), in place of the state badge and the verbs. Everything else this
// environment would say in that time is the run's own side effect (an updating agent drops its socket, so the row
// would read "reconnecting", "last seen now", and raise the concerns a silent machine raises), so it all stands down
// until the run ends or outlives its deadline. Once it has ended, the strip below says how it went.
const run = computed(() => ops.agentRun(environment));
const live = computed(() => agentRunLive(run.value));
const working = useLineWithElapsed(
    () => (live.value && run.value !== undefined ? agentRunWorking(run.value.op) : undefined),
    () => (live.value ? run.value?.startedAt : undefined),
);
// The machine's own output, behind one quiet toggle at the row's end while it works.
const showing = ref(false);
watch(live, (now) => {
    if (!now) {
        showing.value = false;
    }
});

const shownConcerns = computed(() => (live.value ? [] : concerns));
const shownNotes = computed(() => (live.value ? [] : notes.value));
const shownSync = computed(() => (live.value ? undefined : stoppedSync.value));
// Drawn IN PLACE of the concern that offered it when there is one, since that concern is now a question already
// answered: its count is the reading from before the press, and leaving its button live beside the run is what made a
// finished drop look unfinished.
const ended = computed(() => (live.value ? undefined : run.value));
const answers = (concern: Concern): boolean => ended.value !== undefined && concern.fix?.kind === `agent` && concern.fix.op === ended.value.op;
// A run whose concern is gone (the fresh reading no longer raises it) or that no concern offered (a standing button)
// still has to be drawn somewhere: after the concerns, on the same spine.
const standalone = computed(() => ended.value !== undefined && !shownConcerns.value.some(answers));

const below = computed(
    () => shownSync.value !== undefined || shownConcerns.value.length > 0 || shownNotes.value.length > 0 || ended.value !== undefined || showing.value,
);
</script>

<template>
    <!-- The kit's row (DeviceEnvironmentRow), the one the desktop app's Devices view opens on too: this fills it with what
         this sandbox's registry knows, and hangs this environment's errands below it. -->
    <DeviceEnvironmentRow
        :name="device.label"
        :kind="environmentTitle(environment)"
        :mark="os"
        :idle="asleep"
        :masthead="masthead"
        :identity="identity"
        :identity-mono="environmentAddressed(environment)"
        :hardware="hardware"
        :detail="environmentDetail(environment)"
        :seen="lastSeenNote(device)"
        :version="panel?.version"
        :state="{ word: deviceState(device, readAt), variant: deviceTone(device, readAt) }"
        :actions="panel?.actions"
        :running="ops.agentOp(environment)"
        :busy="ops.working.value"
        :working="working"
        @run="(op) => void ops.runAgent(environment, op)"
    >
        <template v-if="live && run && run.lines.length > 0" #aside>
            <Button
                size="small"
                tier="quiet"
                :label="t(`sandbox.agentRun.output`)"
                :aria-expanded="showing"
                @click="showing = !showing"
            >
                <template #icon><Icon name="terminal" /></template>
            </Button>
        </template>
        <!-- Everything this environment WANTS, on a spine under its own mark so it reads as this row's, not the
             machine's. Absent entirely on a healthy one, which is nearly all of them. -->
        <template v-if="below" #below>
            <DeviceRunLog
                v-if="showing && run"
                :lines="run.lines"
                :running="live"
                :empty="t(`sandbox.devicePage.startingOnDevice`)"
                :note="t(`sandbox.devicePage.runsOnDeviceKeeps`)"
            />
            <p v-if="shownSync" class="min-w-0 text-xs text-warning">{{ shownSync }}</p>
            <template v-for="concern in shownConcerns" :key="concern.key">
                <AgentRunStrip v-if="ended && answers(concern)" :run="ended" :machine="device.label" @dismiss="ops.dismissAgent(environment)" />
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
            <DeviceAgentNotes :notes="shownNotes" />
            <AgentRunStrip v-if="ended && standalone" :run="ended" :machine="device.label" @dismiss="ops.dismissAgent(environment)" />
        </template>
    </DeviceEnvironmentRow>
</template>
