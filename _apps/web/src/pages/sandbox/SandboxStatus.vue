<script setup lang="ts">
import { Card, cmp, StatusBadge, type StatusVariant } from "@intentic-app/ui";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { usePanels } from "../../composables/extensions/usePanels";
import { useRunning } from "../../composables/sandbox/useRunning";
import { detectActivations } from "../../extensions/registry";

/* The Sandbox hub's "Status" tab: live things across both classes — operator-panel dev servers (with port +
 * preview) and active services. The only at-a-glance view of what is actually up right now. */

const { panels } = usePanels();
const { capabilities } = useCapabilities();
const { runningPanels, activeServices } = useRunning();

// The rail element that serves a repo (its claiming extension activation, fallback included), for deep-linking
// a running dev server's row to its UI; undefined when nothing serves it.
const activationRoute = (repo: string): string | undefined => {
    const found = detectActivations(panels.value, capabilities.value).find(({ activation }) => activation.repo === repo);
    return found === undefined ? undefined : `/ext/${found.extension.id}/${encodeURIComponent(found.activation.key)}`;
};

const stateVariant = (state: string): StatusVariant =>
    state === `active` ? `success` : state === `error` ? `danger` : state === `pending` ? `warning` : `neutral`;
</script>

<template>
    <Card class="flex flex-col gap-3">
        <div class="flex items-center gap-2.5">
            <Icon name="bolt" class="text-lg text-muted" />
            <div>
                <h2 class="font-semibold leading-tight">Running in this sandbox</h2>
                <p class="text-xs text-muted">Live operator panels and active services — where they are and whether they're healthy.</p>
            </div>
        </div>
        <div v-if="runningPanels.length === 0 && activeServices.length === 0" :class="cmp.emptyState('py-6')">
            Nothing running — open a panel from the sidebar.
        </div>
        <template v-else>
            <!-- Operator-panel dev servers that are up: link to the panel page for controls; port + preview here. -->
            <div
                v-for="panel in runningPanels"
                :key="panel.repo"
                class="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2"
            >
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="window-maximize" class="text-muted" />
                    <router-link
                        v-if="activationRoute(panel.repo) !== undefined"
                        :to="activationRoute(panel.repo)!"
                        class="truncate font-medium text-content hover:text-link hover:underline"
                        >{{ panel.repo }}</router-link
                    >
                    <span v-else class="truncate font-medium text-content">{{ panel.repo }}</span>
                    <span v-if="panel.port" class="font-mono text-2xs text-subtle">:{{ panel.port }}</span>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                    <a
                        v-if="panel.previewUrl && panel.healthy"
                        :href="panel.previewUrl"
                        target="_blank"
                        rel="noopener"
                        class="inline-flex items-center gap-1 text-2xs text-link hover:underline"
                    >
                        Preview<Icon name="external-link" class="text-2xs" />
                    </a>
                    <StatusBadge
                        :variant="panel.healthy ? 'success' : 'warning'"
                        :label="panel.healthy ? 'Healthy' : 'Starting'"
                        size="xs"
                        dot
                    />
                </div>
            </div>
            <!-- Service-type capabilities reporting active (self-hosted stacks, docker, vpn, ssh). URLs live in Live status. -->
            <div
                v-for="service in activeServices"
                :key="service.id"
                class="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2"
            >
                <div class="min-w-0">
                    <span class="truncate font-medium text-content">{{ service.id }}</span>
                    <span class="ml-2 text-2xs text-subtle">{{ service.kind }}</span>
                </div>
                <StatusBadge
                    :variant="stateVariant(service.status.state)"
                    :label="service.status.state"
                    size="xs"
                    dot
                    v-tooltip.top="service.status.detail"
                />
            </div>
        </template>
    </Card>
</template>
