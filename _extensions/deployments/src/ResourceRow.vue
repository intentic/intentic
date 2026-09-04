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

/* One deployment or stack, as a hairline row inside the host's <RowGroup>. Stacks and deployments share this
 * row on purpose: an operator looking for what is down does not want them in two lists, and a stack is just a
 * row that can expand to its services.
 *
 * THE ROW DRAWS NO BOX. It used to carry its own `rounded-lg border bg-card` inside a <RowGroup> that already
 * draws exactly that: a bordered card per row, nested in a bordered card per host, so the board read as forty
 * boxes and the borders stopped meaning anything. What separates rows now is the group's own hairline, and what
 * a row says about itself it says in COLOUR, on the left edge: ext-pipelines' `rowBorder` stripe, scannable
 * down the whole column without reading a word.
 *
 * ONE PRIMARY VERB, chosen by state. Five icon-only buttons per row shipped here, two of which were circular
 * arrows a millimetre apart (redeploy and restart): a coin flip during an incident, which is the one moment
 * this surface exists for. What is left is the verb that is right for the state the row is in, spelled out,
 * plus the recovery verb beside it. The rest live in the expander, where the reader has already stopped to
 * look at one resource rather than scanning forty. */

const props = defineProps<{
    resource: DeployResource;
    busy: boolean;
    logs: { stdout: string; stderr: string } | undefined;
    logsPending: boolean;
    // The last failure from an action on THIS row. It belongs here rather than in a page banner: a 500 from
    // Komodo about `atlas` is unreadable as a red slab at the top of a board of forty rows.
    error: string | undefined;
}>();
const emit = defineEmits<{
    act: [resource: DeployResource, action: DeployAction];
    logs: [resource: DeployResource];
    fix: [resource: DeployResource, pick: AgentRunChoice | undefined];
}>();

/* Which model this row's fix will spend, and the caret that re-points it for this container alone. Seeded from
 * the sandbox's agent-run list: asked of the host rather than read here, so the button and the daemon cannot
 * disagree about what a click costs. Per row, because the choice belongs to the failure you are looking at. */
const fixModel = useAgentRunPick(() => host().models);
const startFix = (): void => {
    emit(`fix`, props.resource, fixModel.overridden.value ? fixModel.model.value : undefined);
    fixModel.clear();
};

const tone = computed(() => STATE_TONE[props.resource.state]);
const expanded = ref(false);

// One toggle for both halves of "show me more": the services a stack is made of, and its log tail. Fetched
// only on the way open: a board of thirty rows must not fetch thirty logs to render.
const toggle = (): void => {
    expanded.value = !expanded.value;
    if (expanded.value && props.logs === undefined) {
        emit(`logs`, props.resource);
    }
};

/* The row's primary action.
 *
 * `pull` WINS over `deploy` whenever a newer image exists, and that is the whole reason this is computed rather
 * than a fixed button: with an update waiting, "Redeploy" quietly ships the image you already have, which is
 * almost never what the click meant. One slot, and the verb in it is the one that does what the reader wants.
 * A resource mid-deploy gets nothing: its state is about to change on its own. */
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

/* Ragged on purpose: a log tail is lines of unequal length, and six identical bars read as a table. Six of
 * them, because <Code>'s scroll viewport is fourteen lines and a placeholder taller than the answer usually
 * is would make the block SHRINK when the real tail arrives, which is the one reflow an outline exists to prevent.
 *
 * FRACTIONS, NOT PERCENTAGES. An extension bundle is not scanned by the app's Tailwind build: it draws from the
 * class surface `extension-surface.css` promises, which enumerates the fraction scale and cannot enumerate an
 * arbitrary bracket value. One of those here is a bar with no width at all in the shipped bundle, and
 * extensionSurface.test.ts fails the build over it — including, as this comment learned, over a bracket value
 * merely QUOTED in prose, since it scans the source rather than parsing it. */
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
    <!-- ONE TOGGLE, and there used to be two: this button AND a trailing chevron in the verb cluster, the same
         action twice, a second tab stop, and the trailing copy carried no `aria-expanded` at all. It also sat
         among Start, Stop and Open-in-Komodo, which is the mistake the ports list made with its `(i)`: a
         navigation control filed under side effects.

         `body="drawer"`: what opens is the resource's own report — services, ports, the container log — with
         headings of its own, not a fact hanging off its name. -->
    <DisclosureRow class="border-l-4" :class="tone.rowBorder" density="comfortable" body="drawer" :open="expanded" @update:open="toggle">
        <template #lead>
            <Icon :name="tone.icon" :spin="tone.spin" class="shrink-0 text-base" :class="tone.text" />
        </template>

        <template #title>
            <span class="flex flex-wrap items-center gap-x-2 gap-y-1 font-normal">
                <span class="truncate text-sm font-medium text-content">{{ resource.name }}</span>
                <!-- Kind is a fact about the row, not a state: it wears the same neutral chip the CI
                             trigger does rather than a coloured badge, which is reserved for what is wrong. -->
                <span v-if="resource.kind === `stack`" class="shrink-0 rounded border border-line px-1.5 py-px text-2xs font-medium text-subtle">
                    stack
                </span>
                <StatusBadge v-if="resource.updateAvailable" variant="info" size="xs" label="new image" class="shrink-0" />
            </span>
        </template>

        <template #description>
            <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-subtle">
                <!-- Komodo's own prose ("Up 4 days", "Exited (1) 20 minutes ago") is more precise than
                     anything we would compose from the state word, so it leads. -->
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

            <!-- A stack's services ride the list response, so this costs no extra call. Two columns of plain
                 text rather than a wrap of bordered chips: the names are what the reader is scanning for, and
                 forty characters of shared registry prefix in front of each one is what buried them. -->
            <div v-if="resource.services.length > 0" class="@container mb-3">
                <div :class="ui.sectionLabel(`mb-1.5 text-2xs`)">Services</div>
                <!-- Two columns against THIS block, not the window: the panel it sits in is as wide as the reader
                     left the workspace pane, and a viewport query put two 160px columns in it. -->
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
                <AgentRunButton
                    label="Ask the agent to fix"
                    icon="sparkles"
                    :model-label="fixModel.model.value.label"
                    :effort-label="fixModel.model.value.effortLabel"
                    :overridden="fixModel.overridden.value"
                    :loading="busy"
                    :disabled="busy"
                    @run="startFix"
                    @pick="fixModel.choose"
                />
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

            <!-- THE SHAPE OF THE LOG, WHILE IT IS BEING FETCHED, rather than the words "Reading logs…" on one
                 grey line. The row opens instantly and the tail arrives over a network hop to Komodo, so what
                 that line did was open a row onto almost nothing and then reflow it a second later. An outline
                 the size of the block that is coming holds the space, says "working" without a sentence, and
                 lets the real tail land in place. Built from the same label + bordered band <Code> draws, so it
                 cannot drift from the thing it stands in for. -->
            <div v-if="logsPending && logText === ``" class="flex flex-col gap-1.5" role="status" aria-busy="true" aria-label="Reading logs">
                <span class="skeleton h-2.5 w-24"></span>
                <div class="flex flex-col gap-1.5 rounded-md border border-line bg-canvas px-3 py-2.5">
                    <span v-for="(width, line) in LOG_SKELETON" :key="line" class="skeleton h-2.5" :class="width"></span>
                </div>
            </div>
            <!-- The shared code block: a copy button (a log tail's whole point is that it goes somewhere else)
                 and a scroll viewport, so a 200-line tail stays in place instead of pushing the next row off screen. -->
            <Code v-else-if="logText !== ``" :code="logText" lang="log" label="Container log" :scroll-lines="14" />
            <div v-else class="text-2xs text-subtle">No log output.</div>
        </template>
    </DisclosureRow>
</template>
