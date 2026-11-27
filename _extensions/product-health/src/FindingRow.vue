<script setup lang="ts">
import {
    type ActionItem,
    AgentRunButton,
    type AgentRunBooking,
    type AgentRunChoice,
    appLink,
    Button,
    DisclosureRow,
    fixStanceLook,
    Icon,
    OverflowActions,
    StatusBadge,
    useAgentRunPick,
} from "@intentic/extension-ui";
import type { FixResume } from "@intentic/sandbox-contract/state/fix-attempt-plan";
import { computed } from "vue";
import FindingEvidence from "./FindingEvidence.vue";
import { host } from "./host";
import { t } from "./i18n.js";
import { descriptionOf, type SectionId, titleOf } from "./sections";
import type { Finding } from "./wire";

// One finding: its title and the one line PostHog's numbers make, the agent on it (as the Pipelines board draws a fix
// agent's chip), the press that puts one on it, and the rest of its presses behind the row's ⋯. The evidence opens under it.

const {
    finding,
    section,
    now,
    many,
    canWrite,
    busy,
    open = false,
} = defineProps<{
    finding: Finding;
    section: SectionId;
    now: number;
    // More than one PostHog connection: each row names its own.
    many: boolean;
    // A maintainer or the owner: may change what PostHog holds.
    canWrite: boolean;
    // The finding a press is under way on, if any: one at a time.
    busy: string | undefined;
    open?: boolean;
}>();
const emit = defineEmits<{
    fix: [finding: Finding, pick: AgentRunChoice | undefined, resume: FixResume | undefined, booking: AgentRunBooking | undefined];
    resolve: [finding: Finding];
    snooze: [finding: Finding];
    dismiss: [finding: Finding];
    wire: [connection: string];
    "update:open": [open: boolean];
}>();

const api = host();

// The attempt already on this finding rides into the picker, so its bar ends in Continue / Start over.
const picker = useAgentRunPick(
    () => api.models,
    `product-health-fix`,
    () => (finding.agent === undefined ? undefined : { summary: finding.agent.label, continuable: finding.agent.stance === `ended` }),
);

// The agent's chip: its stance in the contract's words, linked to its conversation. A step the agent named outranks it.
const agentChip = computed(() => {
    const agent = finding.agent;
    if (agent === undefined) {
        return undefined;
    }
    const look = fixStanceLook(agent.ownerStep === undefined ? agent.stance : `needs-you`);
    const link = appLink(api.href(api.links.agent(agent.conversationId)), () => api.chat.openAgent(agent.conversationId));
    return { ...look, link, label: agent.label };
});

// The press shows while nothing is in play: no agent yet, or the last one ended or landed without the finding clearing.
const showFix = computed(
    () => finding.actions.includes(`fix`) && finding.agent?.ownerStep === undefined && (finding.agent === undefined || finding.agent.stance === `ended` || finding.agent.stance === `landed`),
);
const fixLabel = computed(() => (finding.lane === `decide` ? t(`row.decide`) : finding.lane === `setup` ? t(`row.setupFix`) : t(`row.fix`)));
// The accent goes to what owes the reader most: a fix nobody is on that is not merely informational.
const loud = computed(() => section === `fix` && finding.severity !== `info`);

const tone = computed(() => (finding.cameBack === true || (section === `fix` && finding.severity === `critical`) ? `danger` : section === `fix` && finding.severity === `warning` ? `warning` : undefined));

const startFix = (): void => {
    emit(`fix`, finding, picker.overridden.value ? picker.model.value : undefined, picker.resume.value, picker.booking.value);
    picker.clear();
};

const presses = computed<ActionItem[]>(() => {
    const items: ActionItem[] = [];
    if (canWrite && finding.actions.includes(`resolve`)) {
        items.push({ id: `resolve`, label: t(`row.resolve`), icon: `check`, note: t(`row.resolveHint`), disabled: busy !== undefined, run: () => emit(`resolve`, finding) });
    }
    if (canWrite && finding.actions.includes(`snooze`)) {
        items.push({ id: `snooze`, label: t(`row.snooze`), icon: `clock`, disabled: busy !== undefined, run: () => emit(`snooze`, finding) });
    }
    if (canWrite && finding.actions.includes(`dismiss`)) {
        items.push({ id: `dismiss`, label: t(`row.dismiss`), icon: `times`, disabled: busy !== undefined, run: () => emit(`dismiss`, finding) });
    }
    items.push({ id: `open`, label: t(`row.openInPostHog`), icon: `external-link`, run: () => window.open(finding.link, `_blank`, `noopener`) });
    return items;
});
</script>

<template>
    <DisclosureRow
        :title="titleOf(finding)"
        :description="descriptionOf(finding, now, many)"
        :tone="tone"
        :open="open"
        @update:open="(next: boolean) => emit(`update:open`, next)"
    >
        <template #control>
            <!-- The one fact a section cannot carry: this was marked fixed and it is back. -->
            <StatusBadge v-if="finding.cameBack" variant="danger" :label="t(`describe.cameBack`)" size="sm" />
            <a v-if="agentChip" v-bind="agentChip.link" class="ui-chip shrink-0 font-medium" :class="[agentChip.ink, agentChip.chip]">
                <Icon :name="agentChip.icon" :spin="agentChip.spin" class="text-2xs" />
                {{ agentChip.label }}
            </a>
            <Button
                v-if="canWrite && finding.actions.includes(`wire`)"
                :label="t(`row.wire`)"
                size="small"
                tier="accent"
                :loading="busy === finding.connection"
                :disabled="busy !== undefined"
                @click="emit(`wire`, finding.connection)"
            />
            <AgentRunButton
                v-if="showFix"
                :label="fixLabel"
                :picker="picker"
                :tier="loud ? `accent` : `quiet`"
                :loading="busy === finding.id"
                :disabled="busy !== undefined"
                @run="startFix"
            />
            <OverflowActions :actions="presses" :header="titleOf(finding)" />
        </template>
        <template #below><FindingEvidence :finding="finding" /></template>
    </DisclosureRow>
</template>
