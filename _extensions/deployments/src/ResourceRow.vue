<script setup lang="ts">
import type { DeployAction, DeployResource } from "@intentic/sandbox-contract";
import { Button, cmp, Code, Icon, StatusBadge } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { imageLabel, STATE_TONE } from "./stateVisual";

/* One deployment or stack, as a hairline row inside the host's <RowGroup>. Stacks and deployments share this
 * row on purpose: an operator looking for what is down does not want them in two lists, and a stack is just a
 * row that can expand to its services.
 *
 * THE ROW DRAWS NO BOX. It used to carry its own `rounded-lg border bg-card` inside a <RowGroup> that already
 * draws exactly that — a bordered card per row, nested in a bordered card per host, so the board read as forty
 * boxes and the borders stopped meaning anything. What separates rows now is the group's own hairline, and what
 * a row says about itself it says in COLOUR, on the left edge: ext-pipelines' `rowBorder` stripe, scannable
 * down the whole column without reading a word.
 *
 * ONE PRIMARY VERB, chosen by state. Five icon-only buttons per row shipped here, two of which were circular
 * arrows a millimetre apart (redeploy and restart) — a coin flip during an incident, which is the one moment
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
    fix: [resource: DeployResource];
}>();

const tone = computed(() => STATE_TONE[props.resource.state]);
const expanded = ref(false);

// One toggle for both halves of "show me more": the services a stack is made of, and its log tail. Fetched
// only on the way open — a board of thirty rows must not fetch thirty logs to render.
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
 * A resource mid-deploy gets nothing — its state is about to change on its own. */
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

const logText = computed(() => {
    const log = props.logs;
    if (log === undefined) {
        return ``;
    }
    return [log.stdout, log.stderr].filter((part) => part.trim() !== ``).join(`\n`);
});
</script>

<template>
    <div class="group border-l-[3px] transition-colors" :class="[tone.rowBorder, expanded ? `bg-content/[0.02]` : `hover:bg-content/[0.02]`]">
        <div class="flex w-full items-center gap-3 px-4 py-3">
            <button type="button" class="flex min-w-0 flex-1 items-center gap-3 text-left" @click="toggle">
                <Icon :name="tone.icon" class="shrink-0 text-base" :class="[tone.text, tone.spin ? `animate-spin` : ``]" />
                <span class="min-w-0 flex-1">
                    <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span class="truncate text-sm font-medium text-content">{{ resource.name }}</span>
                        <!-- Kind is a fact about the row, not a state: it wears the same neutral chip the CI
                             trigger does rather than a coloured badge, which is reserved for what is wrong. -->
                        <span
                            v-if="resource.kind === `stack`"
                            class="shrink-0 rounded border border-line px-1.5 py-px text-2xs font-medium text-subtle"
                        >
                            stack
                        </span>
                        <StatusBadge v-if="resource.updateAvailable" variant="info" size="xs" label="New image" class="shrink-0" />
                    </span>
                    <span class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-subtle">
                        <!-- Komodo's own prose ("Up 4 days", "Exited (1) 20 minutes ago") is more precise than
                             anything we would compose from the state word, so it leads. -->
                        <span class="truncate">{{ resource.status ?? tone.label }}</span>
                        <span v-if="resource.image" class="truncate font-mono" v-tooltip.top="resource.image">{{ imageLabel(resource.image) }}</span>
                    </span>
                </span>
            </button>

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
                <a :href="resource.url" target="_blank" rel="noopener" :class="cmp.iconButton()" v-tooltip.top="`Open in Komodo`">
                    <Icon name="arrow-up-right" class="text-xs" />
                </a>
                <button type="button" :class="cmp.iconButton()" :title="expanded ? `Hide details` : `Show details`" @click="toggle">
                    <Icon name="chevron-down" class="text-2xs transition-transform" :class="expanded ? `rotate-180` : ``" />
                </button>
            </div>
        </div>

        <div v-if="expanded" class="border-t border-line/60 px-4 pb-4 pt-3">
            <!-- Whatever Komodo refused, next to the button that asked. -->
            <div v-if="error" :class="cmp.alertDanger(`mb-3 break-words`)">{{ error }}</div>

            <!-- A stack's services ride the list response, so this costs no extra call. Two columns of plain
                 text rather than a wrap of bordered chips: the names are what the reader is scanning for, and
                 forty characters of shared registry prefix in front of each one is what buried them. -->
            <div v-if="resource.services.length > 0" class="mb-3">
                <div :class="cmp.sectionLabel(`mb-1.5 text-2xs`)">Services</div>
                <div class="grid gap-x-6 gap-y-1 sm:grid-cols-2">
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
                     and it wears the same chrome as Pipelines' "Fix with agent" because it is the same act. -->
                <Button label="Ask the agent to fix" size="small" :loading="busy" :disabled="busy" @click="emit(`fix`, resource)">
                    <template #icon><Icon name="sparkles" /></template>
                </Button>
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

            <div v-if="logsPending && logText === ``" class="text-2xs text-subtle">Reading logs…</div>
            <!-- The shared code block: a copy button (a log tail's whole point is that it goes somewhere else)
                 and a clamp, so a 200-line tail does not push the next row off the screen. -->
            <Code v-else-if="logText !== ``" :code="logText" lang="log" label="Container log" :clamp-lines="14" />
            <div v-else class="text-2xs text-subtle">No log output.</div>
        </div>
    </div>
</template>
