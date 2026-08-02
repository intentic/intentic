<script setup lang="ts">
import { Row, RowGroup, StatusBadge, type StatusVariant } from "@intentic/ui";
import VpnCard from "../../components/VpnCard.vue";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { usePanels } from "../../composables/extensions/usePanels";
import { useRunning } from "../../composables/sandbox/useRunning";
import { detectActivations, extensionPath } from "../../core-views/registry";

/* The Sandbox hub's "Status" tab: live things across both classes — operator-panel dev servers (with port +
 * preview) and active services — plus the VPN card, which is where a tunnel is connected and disconnected.
 * The only at-a-glance view of what is actually up right now. */

const { panels } = usePanels();
const { capabilities } = useCapabilities();
const { runningPanels, activeServices } = useRunning();

// The rail element that serves a repo (its claiming extension activation, fallback included), for deep-linking
// a running dev server's row to its UI; undefined when nothing serves it.
const activationRoute = (repo: string): string | undefined => {
    const found = detectActivations(panels.value, capabilities.value).find(({ activation }) => activation.repo === repo);
    return found === undefined ? undefined : extensionPath(found.extension, found.activation);
};

const stateVariant = (state: string): StatusVariant =>
    state === `active` ? `success` : state === `error` ? `danger` : state === `pending` ? `warning` : `neutral`;
</script>

<template>
    <div class="flex flex-col gap-4">
        <!-- VPN first: whether the sandbox's traffic leaves through a tunnel changes what everything below it
             can reach, so it reads before the list of what's running. -->
        <VpnCard />

        <RowGroup label="Running now">
            <div v-if="runningPanels.length === 0 && activeServices.length === 0" class="px-4 py-6 text-center text-xs text-muted">
                Nothing running — open a panel from the sidebar.
            </div>
            <template v-else>
                <!-- Operator-panel dev servers that are up: link to the panel page for controls; port + preview here. -->
                <Row v-for="panel in runningPanels" :key="panel.repo" icon="window-maximize">
                    <template #title>
                        <router-link
                            v-if="activationRoute(panel.repo) !== undefined"
                            :to="activationRoute(panel.repo)!"
                            class="hover:text-link hover:underline"
                            >{{ panel.repo }}</router-link
                        >
                        <span v-else>{{ panel.repo }}</span>
                        <span v-if="panel.port" class="ml-1 font-mono text-2xs font-normal text-subtle">:{{ panel.port }}</span>
                    </template>
                    <template #control>
                        <a
                            v-if="panel.previewUrl && panel.healthy"
                            :href="panel.previewUrl"
                            target="_blank"
                            rel="noopener"
                            class="inline-flex items-center gap-1 text-2xs text-link hover:underline"
                        >
                            Preview<Icon name="external-link" class="text-2xs" />
                        </a>
                        <StatusBadge :variant="panel.healthy ? 'success' : 'warning'" :label="panel.healthy ? 'Healthy' : 'Starting'" size="xs" dot />
                    </template>
                </Row>
                <!-- Service-type capabilities reporting active (self-hosted stacks, ssh, docker). VPNs are NOT
                     here — they have their own card above, with the detail and the controls a tunnel needs. -->
                <Row v-for="service in activeServices" :key="service.id" icon="server">
                    <template #title>
                        {{ service.id }}<span class="ml-2 text-2xs font-normal text-subtle">{{ service.kind }}</span>
                    </template>
                    <template #control>
                        <StatusBadge
                            :variant="stateVariant(service.status.state)"
                            :label="service.status.state"
                            size="xs"
                            dot
                            v-tooltip.top="service.status.detail"
                        />
                    </template>
                </Row>
            </template>
        </RowGroup>
    </div>
</template>
