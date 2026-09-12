<script setup lang="ts">
import type { DeployAction, DeployResource } from "./contract";
import {
    AgentRunButton,
    Button,
    ui,
    Code,
    DisclosureRow,
    Icon,
    Notice,
    noticeOf,
    StatusBadge,
    type AgentRunChoice,
    useAgentRunPick,
} from "@intentic/extension-ui";
import { host } from "./host";
import { computed, ref } from "vue";
import { imageLabel, STATE_TONE } from "./stateVisual";

// One row for both a deployment and a stack, so an operator scanning for what's down sees one list. No border of its
// own: separation is the group's hairline, and state shows as colour on the left edge (mirrors ext-pipelines'
// rowBorder). One primary verb by state, plus a recovery verb; the rest lives in the expander.

const props = defineProps<{
    resource: DeployResource;
    busy: boolean;
    logs: { stdout: string; stderr: string } | undefined;
    logsPending: boolean;
    // Last failure from an action on this row, shown here rather than a page banner.
    error: string | undefined;
}>();
const emit = defineEmits<{
    act: [resource: DeployResource, action: DeployAction];
    logs: [resource: DeployResource];
    fix: [resource: DeployResource, pick: AgentRunChoice | undefined];
}>();

// Model this row's fix will spend; asked of the host so the button and the daemon can't disagree.
const fixModel = useAgentRunPick(() => host().models, `deployment-fix`);
const startFix = (): void => {
    emit(`fix`, props.resource, fixModel.overridden.value ? fixModel.model.value : undefined);
    fixModel.clear();
};

const tone = computed(() => STATE_TONE[props.resource.state]);
const expanded = ref(false);

// One toggle for both halves of "show more" (services, log tail); logs fetch only on the way open.
const toggle = (): void => {
    expanded.value = !expanded.value;
    if (expanded.value && props.logs === undefined) {
        emit(`logs`, props.resource);
    }
};

// Row's primary action: `pull` wins over `deploy` whenever a newer image exists, since Redeploy would otherwise quietly
// ship the image already running. Nothing while mid-deploy, since the state is about to change on its own.
const primary = computed<{ action: DeployAction; label: string } | undefined>(() => {
    if (props.resource.state === `deploying`) {
        return undefined;
    }
    if (props.resource.updateAvailable) {
        return { action: `pull`, label: `Update` };
    }
    return { action: `deploy`, label: `Redeploy` };
});

// The recovery verb beside it: bring it back if it is down, bounce it if it is up.
const secondary = computed<{ action: DeployAction; label: string } | undefined>(() => {
    if (props.resource.state === `running` || props.resource.state === `unhealthy`) {
        return { action: `restart`, label: `Restart` };
    }
    return props.resource.state === `stopped` ? { action: `start`, label: `Start` } : undefined;
});

// Fraction widths only: extension-surface.css enumerates the scale, and other classes fail the build.
const LOG_SKELETON = [`w-11/12`, `w-3/5`, `w-3/4`, `w-2/5`, `w-5/6`, `w-1/2`] as const;

const logText = computed(() => {
    const log = props.logs;
    if (log === undefined) {
        return ``;
    }
    return [log.stdout, log.stderr].filter((part) => part.trim() !== ``).join(`\n`);
});
</script>

<template>
    <!-- One toggle for the row; the drawer holds the resource's own report, not a fact hung off its name. -->
    <DisclosureRow class="border-l-4" :class="tone.rowBorder" density="comfortable" body="drawer" :open="expanded" @update:open="toggle">
        <template #lead="{ iconClass }">
            <Icon :name="tone.icon" :spin="tone.spin" class="shrink-0" :class="[iconClass, tone.text]" />
        </template>

        <template #title>
            <span class="flex flex-wrap items-center gap-x-2 gap-y-1 font-normal">
                <span class="truncate text-sm font-medium text-content">{{ resource.name }}</span>
                <!-- Kind is a fact, not a state, so it wears a neutral chip, not a coloured badge (reserved for problems). -->
                <span v-if="resource.kind === `stack`" class="shrink-0 rounded border border-line px-2.5 py-1 text-2xs font-medium text-subtle">
                    stack
                </span>
                <StatusBadge v-if="resource.updateAvailable" variant="info" size="xs" label="new image" class="shrink-0" />
            </span>
        </template>

        <template #description>
            <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-subtle">
                <!-- Komodo's own status prose is more precise than anything composed from the state word, so it leads. -->
                <span class="truncate">{{ resource.status ?? tone.label }}</span>
                <span v-if="resource.image" class="truncate font-mono" v-tooltip.top="resource.image">{{ imageLabel(resource.image) }}</span>
            </span>
        </template>

        <template #control>
            <div class="flex shrink-0 items-center gap-1">
                <Button
                    v-if="primary"
                    :label="primary.label"
                    size="small"
                    severity="secondary"
                    text
                    :loading="busy"
                    :disabled="busy"
                    @click="emit(`act`, resource, primary.action)"
                />
                <Button
                    v-if="secondary"
                    :label="secondary.label"
                    size="small"
                    severity="secondary"
                    text
                    :disabled="busy"
                    @click="emit(`act`, resource, secondary.action)"
                />
                <a :href="resource.url" target="_blank" rel="noopener" :class="ui.iconButton()" v-tooltip.top="`Open in Komodo`">
                    <Icon name="arrow-up-right" class="text-xs" />
                </a>
            </div>
        </template>

        <template #below>
            <!-- Whatever Komodo refused, next to the button that asked. -->
            <Notice v-if="error" :of="noticeOf(error)" class="mb-3" />

            <!-- Services ride the list response already, no extra call; plain columns avoid a shared prefix burying names. -->
            <div v-if="resource.services.length > 0" class="@container mb-3">
                <div :class="ui.sectionLabel(`mb-1.5 text-2xs`)">Services</div>
                <!-- Queries this block's width, not the viewport: the panel's width follows the workspace pane, not the window. -->
                <div class="grid gap-x-6 gap-y-1 @lg:grid-cols-2">
                    <div v-for="service in resource.services" :key="service.name" class="flex min-w-0 items-baseline gap-2 text-2xs">
                        <span class="shrink-0 font-medium text-content">{{ service.name }}</span>
                        <span class="truncate font-mono text-subtle" v-tooltip.top="service.image">{{ imageLabel(service.image) }}</span>
                        <Icon
                            v-if="service.updateAvailable"
                            name="arrow-circle-up"
                            class="shrink-0 text-info"
                            v-tooltip.top="`A newer image exists`"
                        />
                    </div>
                </div>
            </div>

            <div class="mb-3 flex flex-wrap items-center gap-2">
                <!-- The one thing this surface can do that Komodo's own UI cannot: put an agent on the failure
                     with the repo that holds the bug already open. It is the only primary button on the row,
                     and it IS Pipelines' "Fix with agent": the same component, because it is the same act:
                     one click on the standing model, a caret for the container that wants a bigger one. -->
                <AgentRunButton label="Ask the agent to fix" icon="sparkles" :picker="fixModel" :loading="busy" :disabled="busy" @run="startFix" />
                <Button
                    v-if="resource.state !== `stopped`"
                    label="Stop"
                    size="small"
                    severity="secondary"
                    text
                    :disabled="busy"
                    @click="emit(`act`, resource, `stop`)"
                />
                <Button label="Refresh logs" size="small" severity="secondary" text :disabled="logsPending" @click="emit(`logs`, resource)" />
            </div>

            <!-- Holds the log's eventual space to avoid a reflow; shaped like <Code> itself so the two can't drift. -->
            <div v-if="logsPending && logText === ``" class="flex flex-col gap-1.5" role="status" aria-busy="true" aria-label="Reading logs">
                <span class="skeleton h-2.5 w-24"></span>
                <div class="flex flex-col gap-1.5 rounded-md border border-line bg-canvas px-3 py-2.5">
                    <span v-for="(width, line) in LOG_SKELETON" :key="line" class="skeleton h-2.5" :class="width"></span>
                </div>
            </div>
            <!-- Copy button plus a scroll viewport, so a long tail doesn't push the next row off screen. -->
            <Code v-else-if="logText !== ``" :code="logText" lang="log" label="Container log" :scroll-lines="14" />
            <div v-else class="text-2xs text-subtle">No log output.</div>
        </template>
    </DisclosureRow>
</template>
