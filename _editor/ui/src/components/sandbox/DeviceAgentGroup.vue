<!-- One device's agent as an object with verbs, rather than a version printed under the machine's name. -->
<script setup lang="ts" generic="Op extends string">
import StatusBadge from "../feedback/StatusBadge.vue";
import Button from "../primitives/Button.vue";
import Icon from "../primitives/Icon.vue";
import Row from "../rows/Row.vue";
import RowGroup from "../rows/RowGroup.vue";
import RowNote from "../rows/RowNote.vue";
import DeviceAgentNotes from "./DeviceAgentNotes.vue";
import { agentDuties, agentCarries, agentLines, type AgentPanel } from "./deviceAgent.js";
import { useT } from "../../i18n/index.js";

const t = useT();

const {
    panel,
    label,
    subject,
    busy = false,
    running,
    activity = false,
} = defineProps<{
    panel: AgentPanel<Op>;
    /** The group's own label; a surface drawing several machines names which one this is. */
    label?: string;
    /** The machine this loop runs on, for the sentence the duty strip replaced. */
    subject: string;
    /** True while any op on this surface holds its one-at-a-time lock, whichever control started it. */
    busy?: boolean;
    /** The op spinning right now, when one is. */
    running?: Op | undefined;
    // Whether `#activity` has anything in it; a prop rather than the slot's presence, since a caller fills the
    // slot for the whole session and only sometimes has a run to show in it.
    activity?: boolean;
}>();

defineSlots<{
    /** What the last press is doing and what the machine said back: a run log, an outcome, a failure. */
    activity?: () => unknown;
}>();

const emit = defineEmits<{ run: [op: Op] }>();
</script>

<template>
    <!--
        Above the machine's lists because it is what makes their buttons work. The controls are standing ones,
        offered on a healthy agent too: "behind" is a comparison only a caller that knows what has been
        published can make, and a missing button is a walk to the machine to type the command by hand.
    -->
    <RowGroup :label="label ?? t(`ui.deviceAgentGroup.agentOnThisDevice`)">
        <!-- `wideControl`: the trailing cluster takes a line of its own rather than squeezing the headline until
             the duty strip wraps, which would drag the lead mark off the title it belongs to. -->
        <Row
            icon="desktop"
            :wide-control="true"
            :title="panel.version === undefined ? t(`ui.deviceAgentGroup.agent`) : t(`ui.deviceAgentGroup.agent2`, { version: panel.version })"
        >
            <!-- What the process carries, as three glyphs: the sentence it replaced is on hover. -->
            <template #description>
                <span v-tooltip.top="agentCarries(subject)" class="flex w-fit flex-wrap items-center gap-x-3 gap-y-0.5">
                    <span v-for="duty in agentDuties()" :key="duty.label" class="inline-flex items-center gap-1">
                        <Icon :name="duty.icon" aria-hidden="true" />{{ duty.label }}
                    </span>
                </span>
            </template>
            <template #meta>
                <span v-for="fact in panel.facts" :key="fact" class="font-mono">{{ fact }}</span>
                <StatusBadge :variant="panel.state.variant" size="xs" :dot="true" :label="panel.state.word" />
            </template>
            <!-- Every verb here runs on that machine, so each spins the whole surface's lock rather than its own. -->
            <template v-if="panel.actions.length > 0" #control>
                <Button
                    v-for="action in panel.actions"
                    :key="action.op"
                    size="small"
                    severity="secondary"
                    :label="action.label"
                    :loading="running === action.op"
                    :disabled="busy"
                    v-tooltip.top="action.hint"
                    @click="emit(`run`, action.op)"
                />
            </template>
        </Row>

        <!-- The settled case still gets its one quiet line, so the buttons beside it are never unexplained. -->
        <RowNote v-if="agentLines(panel).length > 0" variant="block"><DeviceAgentNotes :notes="agentLines(panel)" /></RowNote>

        <RowNote v-if="activity" variant="block">
            <div class="flex min-w-0 flex-col gap-2"><slot name="activity" /></div>
        </RowNote>
    </RowGroup>
</template>
