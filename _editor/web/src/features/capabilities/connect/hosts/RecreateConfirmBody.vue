<!-- What saying yes to an update, a rebuild or a rollback does, drawn rather than told: the steps in the order they land
     with how long each takes, the agents the restart cuts, and that the files stay. -->
<script setup lang="ts">
import { type IconName, toneWash, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import Checkbox from "primevue/checkbox";
import { computed, ref } from "vue";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import ProviderLogo from "../../../../parts/providers/ProviderLogo.vue";
import type { RecreateAction } from "./recreateWords";

const t = useT();

const props = defineProps<{
    action: RecreateAction;
    // The update is already on that machine, so the only step left is the restart.
    ready?: boolean;
    // Mid-turn now: what the restart at the end cuts.
    agents: readonly Pick<FleetAgent, "id" | "title" | "provider">[];
    // The owner can choose here whether they resume (the box), or `resumes` is already settled by their setting.
    offerResume: boolean;
    resumes: boolean;
}>();
const resumeAfter = defineModel<boolean>("resumeAfter", { required: true });

interface Step {
    icon: IconName;
    label: string;
    note?: string;
    takes?: string;
    // Already behind it: drawn in the colour of done, with no time against it.
    done?: boolean;
}

// The download or build interrupts nothing; only the restart at the end does, and that is half a minute.
const steps = computed((): readonly Step[] => {
    const reconnects = t(`capabilities.hostRecreate.stepReconnects`);
    if (props.action === `Roll back`) {
        return [{ icon: `history`, label: t(`capabilities.hostRecreate.stepRollBack`), note: reconnects, takes: `~30s` }];
    }
    const restart: Step = { icon: `refresh`, label: t(`capabilities.hostRecreate.stepRestart`), note: reconnects, takes: `~30s` };
    if (props.ready === true) {
        return [{ icon: `check`, label: t(`capabilities.hostRecreate.stepDownloaded`), done: true }, restart];
    }
    const work: Step =
        props.action === `Rebuild`
            ? { icon: `hammer`, label: t(`capabilities.hostRecreate.stepRebuild`) }
            : { icon: `cloud-download`, label: t(`capabilities.hostRecreate.stepDownload`) };
    return [{ ...work, note: t(`capabilities.hostRecreate.stepKeepWorking`), takes: t(`capabilities.hostRecreate.stepMinutes`) }, restart];
});

// A few names say which work this is; the rest fold behind a count, one press from the whole list.
const NAMED = 3;
const unfolded = ref(false);
const count = computed(() => props.agents.length);
// One more name costs the same line its "+1 more" would, so a list one over the cut shows whole.
const folds = computed(() => !unfolded.value && count.value > NAMED + 1);
const named = computed(() => (folds.value ? props.agents.slice(0, NAMED) : props.agents));
// A turn the sandbox picks up again is paused; one that waits for the owner is stopped.
const agentsLabel = computed(() =>
    props.resumes
        ? t(`capabilities.hostRecreate.agentsPause`, { count: count.value }, count.value)
        : t(`capabilities.hostRecreate.agentsStop`, { count: count.value }, count.value),
);
</script>

<template>
    <div class="flex flex-col gap-3">
        <ol class="flex flex-col gap-3">
            <li v-for="step in steps" :key="step.label" class="flex items-start gap-2.5">
                <span :class="toneWash(step.done ? `success` : `primary`, `grid size-6 shrink-0 place-items-center rounded-full`)">
                    <Icon :name="step.icon" />
                </span>
                <span class="min-w-0 flex-1">
                    <span class="block text-xs" :class="step.done ? `text-muted` : `text-content`">{{ step.label }}</span>
                    <span v-if="step.note" class="block text-2xs text-subtle">{{ step.note }}</span>
                </span>
                <span v-if="step.takes" class="shrink-0 font-mono text-2xs tabular-nums text-muted">{{ step.takes }}</span>
            </li>

            <!-- The restart's cost, on the same rail as the steps: who it cuts, and whether they carry on after. -->
            <li v-if="count > 0" class="flex items-start gap-2.5">
                <span :class="toneWash(resumes ? `primary` : `warning`, `grid size-6 shrink-0 place-items-center rounded-full`)">
                    <Icon :name="resumes ? `pause` : `stop`" />
                </span>
                <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span>
                        <span class="block text-xs" :class="resumes ? `text-content` : `text-warning`">{{ agentsLabel }}</span>
                        <!-- Said before the restart, since afterwards nothing can run a cut turn again with one press. -->
                        <label v-if="offerResume" class="mt-1 flex items-center gap-2 text-2xs text-content">
                            <Checkbox v-model="resumeAfter" binary size="small" />
                            {{ t(`capabilities.hostRecreate.agentsResumeAfter`, {}, count) }}
                        </label>
                        <span v-else class="block text-2xs text-subtle">{{
                            resumes ? t(`capabilities.hostRecreate.agentsResume`, {}, count) : t(`capabilities.hostRecreate.agentsWait`, {}, count)
                        }}</span>
                    </span>
                    <ul class="flex flex-col gap-1" :class="unfolded ? `max-h-40 overflow-y-auto` : undefined">
                        <li v-for="agent in named" :key="agent.id" class="flex min-w-0 items-center gap-1.5 text-2xs text-muted">
                            <ProviderLogo v-if="agent.provider" :provider="agent.provider" class="shrink-0 text-subtle" />
                            <span class="truncate">{{ agent.title ?? agent.id }}</span>
                        </li>
                    </ul>
                    <!-- A text press, flush with the names it continues, rather than a button boxed out of line with them. -->
                    <button v-if="folds" type="button" :class="ui.textButton({ size: `xs`, tone: `quiet` })" class="self-start" @click="unfolded = true">
                        {{ t(`capabilities.hostRecreate.agentsMore`, { count: count - NAMED }) }}
                        <Icon name="chevron-down" />
                    </button>
                </div>
            </li>
        </ol>

        <p class="flex items-center gap-2.5 text-2xs text-muted">
            <span class="grid size-6 shrink-0 place-items-center text-success"><Icon name="check" /></span>
            <span>{{ t(`capabilities.hostRecreate.filesKept`) }}</span>
        </p>
    </div>
</template>
