<script setup lang="ts">
import type { DeployAction, DeployResource } from "@intentic/sandbox-contract";
import { Button, Icon } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { STATE_TONE } from "./stateVisual";

/* One deployment or stack. Stacks and deployments share this row on purpose: an operator looking for what is
 * down does not want them in two lists, and a stack is just a row that can expand to its services.
 *
 * The actions are the point of the surface. Read-only would have been a strictly worse Komodo — what this can
 * do that Komodo's own UI cannot is the last button, which puts an agent on the failure with the repo that
 * holds the bug already open. */

const props = defineProps<{
    resource: DeployResource;
    busy: boolean;
    logs: { stdout: string; stderr: string } | undefined;
    logsPending: boolean;
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

const logText = computed(() => {
    const log = props.logs;
    if (log === undefined) {
        return ``;
    }
    return [log.stdout, log.stderr].filter((part) => part.trim() !== ``).join(`\n`);
});
</script>

<template>
    <div class="rounded-lg border border-line bg-card">
        <div class="flex items-center gap-3 px-3 py-2">
            <button type="button" class="flex min-w-0 flex-1 items-center gap-3 text-left" @click="toggle">
                <span class="h-2 w-2 shrink-0 rounded-full" :class="[tone.dot, resource.state === `deploying` ? `animate-pulse` : ``]"></span>
                <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-2">
                        <span class="truncate text-sm font-medium text-content">{{ resource.name }}</span>
                        <span v-if="resource.kind === `stack`" class="rounded border border-line px-1 text-2xs text-subtle">stack</span>
                        <!-- The routine version bump, made visible where the button that performs it lives. -->
                        <span v-if="resource.updateAvailable" class="rounded border border-info/30 bg-info/10 px-1 text-2xs text-info"
                            >↑ new image</span
                        >
                    </span>
                    <span class="mt-0.5 flex items-center gap-2 text-2xs text-subtle">
                        <!-- Komodo's own prose ("Up 4 days", "Exited (1) 20 minutes ago") is more precise than
                             anything we would compose from the state word, so it leads. -->
                        <span class="truncate">{{ resource.status ?? tone.label }}</span>
                        <span v-if="resource.image" class="truncate font-mono">{{ resource.image }}</span>
                    </span>
                </span>
                <Icon :name="expanded ? `chevron-down` : `chevron-right`" class="shrink-0 text-2xs text-subtle" />
            </button>

            <div class="flex shrink-0 items-center gap-1">
                <Button
                    v-if="resource.updateAvailable"
                    size="small"
                    severity="secondary"
                    text
                    :disabled="busy"
                    v-tooltip.top="`Pull the newer image and deploy it`"
                    @click="emit(`act`, resource, `pull`)"
                >
                    Pull &amp; deploy
                </Button>
                <Button size="small" severity="secondary" text :disabled="busy" v-tooltip.top="`Redeploy`" @click="emit(`act`, resource, `deploy`)">
                    <Icon name="refresh" />
                </Button>
                <Button
                    v-if="resource.state === `running` || resource.state === `unhealthy`"
                    size="small"
                    severity="secondary"
                    text
                    :disabled="busy"
                    v-tooltip.top="`Restart`"
                    @click="emit(`act`, resource, `restart`)"
                >
                    <Icon name="sync" />
                </Button>
                <Button
                    v-if="resource.state === `stopped`"
                    size="small"
                    severity="secondary"
                    text
                    :disabled="busy"
                    v-tooltip.top="`Start`"
                    @click="emit(`act`, resource, `start`)"
                >
                    <Icon name="play" />
                </Button>
                <Button v-else size="small" severity="secondary" text :disabled="busy" v-tooltip.top="`Stop`" @click="emit(`act`, resource, `stop`)">
                    <Icon name="stop" />
                </Button>
                <a :href="resource.url" target="_blank" rel="noopener" class="px-1 text-subtle hover:text-link" v-tooltip.top="`Open in Komodo`">
                    <Icon name="arrow-up-right" class="text-xs" />
                </a>
            </div>
        </div>

        <div v-if="expanded" class="border-t border-line px-3 py-2">
            <!-- A stack's services ride the list response, so this costs no extra call. -->
            <div v-if="resource.services.length > 0" class="mb-2 flex flex-wrap gap-1.5">
                <span
                    v-for="service in resource.services"
                    :key="service.name"
                    class="inline-flex items-center gap-1.5 rounded-md border border-line bg-canvas px-2 py-1 text-2xs"
                >
                    <span class="font-medium text-content">{{ service.name }}</span>
                    <span class="truncate font-mono text-subtle">{{ service.image }}</span>
                    <span v-if="service.updateAvailable" class="text-info">↑</span>
                </span>
            </div>

            <div class="mb-2 flex items-center gap-2">
                <Button size="small" severity="secondary" outlined :disabled="busy" @click="emit(`fix`, resource)">
                    <Icon name="sparkles" class="mr-1" />
                    Ask the agent to fix
                </Button>
                <Button size="small" severity="secondary" text :disabled="logsPending" @click="emit(`logs`, resource)">Refresh logs</Button>
            </div>

            <div v-if="logsPending && logText === ``" class="text-2xs text-subtle">Reading logs…</div>
            <pre v-else-if="logText !== ``" class="max-h-64 overflow-auto rounded-md bg-canvas p-2 font-mono text-2xs leading-relaxed text-muted">{{
                logText
            }}</pre>
            <div v-else class="text-2xs text-subtle">No log output.</div>
        </div>
    </div>
</template>
